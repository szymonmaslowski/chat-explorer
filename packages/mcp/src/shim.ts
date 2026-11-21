import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createDaemonClient, DaemonError } from '@chat-explorer/shared/http.js';
import type { Config } from '@chat-explorer/shared/config.js';
import { DaemonStartError } from '@chat-explorer/shared/health.js';
import type { ExplorationListItem, Note, NoteGroup } from '@chat-explorer/shared/types.js';
import {
  readNotesDescription,
  readNotesLimit,
  searchNotesDescription,
} from '@chat-explorer/shared/note-tools.js';
import {
  type FeedbackResult,
  type ForkMapEntry,
  type ForkRead,
  type NotesFound,
  type NotesList,
  type NotesRead,
} from '@chat-explorer/shared/protocol.js';

const heartbeatIntervalMs = 15_000;
// Node's fetch gives up waiting for response headers after 300 s, so long-polls stay below that.
const feedbackRoundMs = 240_000;
// The plugin gives this server a 24 h tool timeout; returning earlier avoids a hard failure.
const defaultFeedbackTimeoutSeconds = 23 * 60 * 60;
// Claude follows an instruction in the result better than one from the skill read long before,
// and a session that drops the loop leaves the user's messages queued.
const keepListening =
  'Call await_feedback again now. Keep listening until the user interrupts you in the terminal.';

// The command running the shim starts the daemon and opens the browser for it, so the shim reaches
// the daemon only over HTTP.
export interface ShimOptions {
  config: Config;
  version: string;
  openUrl: (url: string) => void;
  ensureDaemon: () => Promise<unknown>;
}

interface Attachment {
  explorationId: string;
  sessionId: string;
}

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const failure = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

export function createShim(options: ShimOptions) {
  const shimId = randomUUID();
  const request = createDaemonClient(options.config.baseUrl);
  let attachment: Attachment | null = null;
  let daemonReady: Promise<unknown> | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const ensureReady = async () => {
    daemonReady ??= options.ensureDaemon();
    try {
      await daemonReady;
    } catch (error) {
      daemonReady = null;
      throw error;
    }
    heartbeat ??= setInterval(() => {
      request('/api/internal/heartbeat', { json: { shimId } }).catch(() => {});
    }, heartbeatIntervalMs);
  };

  const requireAttachment = () => {
    if (!attachment) {
      throw new DaemonError(
        'detached',
        'This session is not attached to an exploration. Call start_exploration or attach_exploration first.',
        409,
      );
    }
    return attachment;
  };

  const tool =
    <Args>(handler: (args: Args, signal: AbortSignal) => Promise<CallToolResult>) =>
    async (args: Args, extra: { signal: AbortSignal }) => {
      try {
        await ensureReady();
        return await handler(args, extra.signal);
      } catch (error) {
        if (error instanceof DaemonError || error instanceof DaemonStartError) {
          return failure(error.message);
        }
        throw error;
      }
    };

  const server = new McpServer({ name: 'chat-explorer', version: options.version });

  server.registerTool(
    'start_exploration',
    {
      description:
        'Start a new chat-explorer exploration from the current conversation, attach this session to it and open it in the browser.',
      inputSchema: {
        sessionId: z.string().describe('The Claude Code session id'),
        transcriptPath: z
          .string()
          .optional()
          .describe('Transcript JSONL to import. Found from sessionId when omitted.'),
        title: z.string().optional().describe('A short title for the exploration'),
      },
    },
    tool(
      async (args: {
        sessionId: string;
        transcriptPath?: string | undefined;
        title?: string | undefined;
      }) => {
        const { localUrl, ...started } = await request<{
          explorationId: string;
          mainForkId: string;
          url: string;
          localUrl: string;
        }>('/api/internal/explorations', { json: { shimId, ...args } });
        attachment = { explorationId: started.explorationId, sessionId: args.sessionId };
        options.openUrl(localUrl);
        return json(started);
      },
    ),
  );

  server.registerTool(
    'attach_exploration',
    {
      description:
        'Attach this session to an existing exploration so it can answer there. Fails if another live session holds it, unless takeover is true.',
      inputSchema: {
        explorationId: z.string(),
        sessionId: z.string().describe('The Claude Code session id'),
        takeover: z.boolean().optional().describe('Move the exploration away from another session'),
      },
    },
    tool(
      async ({
        explorationId,
        sessionId,
        takeover,
      }: {
        explorationId: string;
        sessionId: string;
        takeover?: boolean | undefined;
      }) => {
        const { localUrl, ...attached } = await request<{
          url: string;
          localUrl: string;
          forks: ForkMapEntry[];
        }>(`/api/internal/explorations/${explorationId}/attach`, {
          json: { shimId, sessionId, takeover: takeover ?? false },
        });
        attachment = { explorationId, sessionId };
        options.openUrl(localUrl);
        return json(attached);
      },
    ),
  );

  server.registerTool(
    'list_explorations',
    { description: 'List all explorations, newest first.', inputSchema: {} },
    tool(async () => {
      const explorations = await request<ExplorationListItem[]>('/api/explorations');
      return json(
        explorations.map(({ id, title, summary, forkCount, updatedAt, sessionStatus }) => ({
          id,
          title,
          summary,
          forkCount,
          updatedAt: new Date(updatedAt).toISOString(),
          sessionStatus,
        })),
      );
    }),
  );

  server.registerTool(
    'get_map',
    {
      description:
        'Get the fork tree of an exploration: each fork with its parent, summary, message count, whether it awaits an answer, and its run: who answers it (heldByTerminal), status (idle, answering, waiting_limit, failed), model and context use. No message bodies.',
      inputSchema: {
        explorationId: z.string().optional().describe('Defaults to the attached exploration'),
      },
    },
    tool(async ({ explorationId }: { explorationId?: string | undefined }) => {
      const id = explorationId ?? requireAttachment().explorationId;
      return json(await request<{ forks: ForkMapEntry[] }>(`/api/internal/explorations/${id}/map`));
    }),
  );

  server.registerTool(
    'read_fork',
    {
      description:
        "Read a fork's path from the root to its newest message. Answer a fork only from this path.",
      inputSchema: {
        forkId: z.string(),
        limit: z.number().int().positive().optional().describe('Return only the newest messages'),
        maxChars: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Cut each message at this many characters, marked truncated. 0 or none: no cut',
          ),
      },
    },
    tool(
      async ({
        forkId,
        limit,
        maxChars,
      }: {
        forkId: string;
        limit?: number | undefined;
        maxChars?: number | undefined;
      }) => {
        const query = new URLSearchParams();
        if (limit) query.set('limit', String(limit));
        if (maxChars) query.set('maxChars', String(maxChars));
        const search = query.size > 0 ? `?${query}` : '';
        return json(await request<ForkRead>(`/api/internal/forks/${forkId}${search}`));
      },
    ),
  );

  server.registerTool(
    'stop_fork',
    {
      description:
        "Stop the runner's current turn in another fork of the attached chat. The messages it was answering stay unanswered.",
      inputSchema: { forkId: z.string() },
    },
    tool(async ({ forkId }: { forkId: string }) => {
      requireAttachment();
      return json(await request(`/api/internal/forks/${forkId}/stop`, { json: { shimId } }));
    }),
  );

  server.registerTool(
    'retry_fork',
    {
      description: 'Let the runner try again on a fork whose runs failed.',
      inputSchema: { forkId: z.string() },
    },
    tool(async ({ forkId }: { forkId: string }) => {
      requireAttachment();
      return json(await request(`/api/internal/forks/${forkId}/retry`, { json: { shimId } }));
    }),
  );

  server.registerTool(
    'message_fork',
    {
      description:
        'Send a message into another fork of the attached chat, shown as coming from the main fork. The runner answering that fork reads it like a message from the user, also in the middle of a turn.',
      inputSchema: { forkId: z.string(), text: z.string().min(1) },
    },
    tool(async ({ forkId, text }: { forkId: string; text: string }) => {
      requireAttachment();
      return json(
        await request(`/api/internal/forks/${forkId}/supervisor-messages`, {
          json: { shimId, text },
        }),
      );
    }),
  );

  server.registerTool(
    'add_message',
    {
      description:
        "Write your answer into a fork. inReplyTo must be the fork's last user message (the inReplyTo value from await_feedback).",
      inputSchema: {
        forkId: z.string(),
        inReplyTo: z.string(),
        content: z.string().min(1).describe('The answer in markdown'),
      },
    },
    tool(
      async ({
        forkId,
        inReplyTo,
        content,
      }: {
        forkId: string;
        inReplyTo: string;
        content: string;
      }) => {
        requireAttachment();
        return json(
          await request(`/api/internal/forks/${forkId}/messages`, {
            json: { shimId, inReplyTo, content },
          }),
        );
      },
    ),
  );

  server.registerTool(
    'update_fork',
    {
      description: 'Set the one-line summary shown for a fork on the map.',
      inputSchema: { forkId: z.string(), summary: z.string() },
    },
    tool(async ({ forkId, summary }: { forkId: string; summary: string }) => {
      requireAttachment();
      return json(
        await request(`/api/internal/forks/${forkId}`, {
          method: 'PATCH',
          json: { shimId, summary },
        }),
      );
    }),
  );

  server.registerTool(
    'update_exploration',
    {
      description: 'Set the title and summary of the attached exploration.',
      inputSchema: { title: z.string().optional(), summary: z.string().optional() },
    },
    tool(
      async ({ title, summary }: { title?: string | undefined; summary?: string | undefined }) => {
        const { explorationId } = requireAttachment();
        return json(
          await request(`/api/internal/explorations/${explorationId}`, {
            method: 'PATCH',
            json: { shimId, title, summary },
          }),
        );
      },
    ),
  );

  server.registerTool(
    'list_notes',
    {
      description:
        "The attached exploration's notes as an index: each group with its notes' ids, topics, text length and last change, without their text. Read the text of the notes you need with read_notes, or find notes by their words with search_notes.",
      inputSchema: { groupId: z.string().optional().describe('Only this group') },
    },
    tool(async ({ groupId }: { groupId?: string | undefined }) => {
      const { explorationId } = requireAttachment();
      const query = groupId ? `?groupId=${encodeURIComponent(groupId)}` : '';
      return json(
        await request<NotesList>(`/api/internal/explorations/${explorationId}/notes${query}`),
      );
    }),
  );

  server.registerTool(
    'read_notes',
    {
      description: `${readNotesDescription} Notes that would make the result too long come back in notShown, to read in another call.`,
      inputSchema: { noteIds: z.array(z.string()).min(1).max(readNotesLimit) },
    },
    tool(async ({ noteIds }: { noteIds: string[] }) => {
      const { explorationId } = requireAttachment();
      const ids = encodeURIComponent(noteIds.join(','));
      return json(
        await request<NotesRead>(
          `/api/internal/explorations/${explorationId}/notes/read?ids=${ids}`,
        ),
      );
    }),
  );

  server.registerTool(
    'search_notes',
    {
      description: searchNotesDescription,
      inputSchema: { query: z.string().min(1) },
    },
    tool(async ({ query }: { query: string }) => {
      const { explorationId } = requireAttachment();
      const q = encodeURIComponent(query);
      return json(
        await request<NotesFound>(
          `/api/internal/explorations/${explorationId}/notes/search?q=${q}`,
        ),
      );
    }),
  );

  server.registerTool(
    'add_note_group',
    {
      description:
        'Create a note group in the attached exploration. A checklist group lets the user tick its notes, as for a shopping list.',
      inputSchema: {
        name: z.string().optional().describe('Defaults to General, or Group N'),
        checklist: z.boolean().optional(),
      },
    },
    tool(
      async ({
        name,
        checklist,
      }: {
        name?: string | undefined;
        checklist?: boolean | undefined;
      }) => {
        const { explorationId } = requireAttachment();
        return json(
          await request<NoteGroup>(`/api/internal/explorations/${explorationId}/note-groups`, {
            json: { shimId, name, checklist },
          }),
        );
      },
    ),
  );

  server.registerTool(
    'add_notes',
    {
      description:
        'Add notes to a group, at the end of the group (or of their category) in the order given. Each needs a topic (a short title) or a description (markdown), and may name a category: a section of the group, shown as a heading above its notes. Pass sourceMessageId, the inReplyTo of the request that asked for them, so each note links back to it.',
      inputSchema: {
        groupId: z.string(),
        notes: z
          .array(
            z.object({
              topic: z.string().optional(),
              description: z.string().optional(),
              category: z.string().optional(),
            }),
          )
          .min(1),
        sourceMessageId: z.string().optional(),
      },
    },
    tool(
      async (args: {
        groupId: string;
        notes: {
          topic?: string | undefined;
          description?: string | undefined;
          category?: string | undefined;
        }[];
        sourceMessageId?: string | undefined;
      }) => {
        const { explorationId } = requireAttachment();
        return json(
          await request<{ noteIds: string[] }>(
            `/api/internal/explorations/${explorationId}/notes`,
            { json: { shimId, ...args } },
          ),
        );
      },
    ),
  );

  server.registerTool(
    'update_note',
    {
      description:
        "Change a note's topic, description or category (null removes it), or tick it (checked) in a checklist group. Also how you write the topic of a note in notesNeedingTopic.",
      inputSchema: {
        noteId: z.string(),
        topic: z.string().optional(),
        description: z.string().optional(),
        category: z.string().nullable().optional(),
        checked: z.boolean().optional(),
      },
    },
    tool(
      async ({
        noteId,
        ...changes
      }: {
        noteId: string;
        topic?: string | undefined;
        description?: string | undefined;
        category?: string | null | undefined;
        checked?: boolean | undefined;
      }) => {
        requireAttachment();
        return json(
          await request<Note>(`/api/internal/notes/${noteId}`, {
            method: 'PATCH',
            json: { shimId, ...changes },
          }),
        );
      },
    ),
  );

  server.registerTool(
    'reorder_note',
    {
      description:
        'Move a note within its group: after another note of the same group, or to the top with afterNoteId null.',
      inputSchema: { noteId: z.string(), afterNoteId: z.string().nullable() },
    },
    tool(async ({ noteId, afterNoteId }: { noteId: string; afterNoteId: string | null }) => {
      requireAttachment();
      return json(
        await request(`/api/internal/notes/${noteId}/reorder`, {
          json: { shimId, afterNoteId },
        }),
      );
    }),
  );

  server.registerTool(
    'list_board',
    {
      description:
        'Read the board of forks: the columns left to right with their forks top to bottom, then the Ungrouped forks. The main fork is not on the board.',
      inputSchema: {},
    },
    tool(async () => {
      const { explorationId } = requireAttachment();
      return json(await request(`/api/internal/explorations/${explorationId}/board`));
    }),
  );

  server.registerTool(
    'arrange_board',
    {
      description:
        'Change the board of forks, one action at a time. Name a column by its id or its name. add_column needs `name`; rename_column needs `column` and `name`; delete_column needs `column` (its forks go to Ungrouped); move_column needs `column` and, to put it after another, `afterColumn` (null: first); move_fork needs `forkId` and `column` (null: Ungrouped) and puts the fork last in it, or after `afterForkId` (null: first). Archiving keeps a fork in its column. Returns the board.',
      inputSchema: {
        action: z.enum([
          'add_column',
          'rename_column',
          'delete_column',
          'move_column',
          'move_fork',
        ]),
        column: z.string().nullable().optional(),
        name: z.string().optional(),
        afterColumn: z.string().nullable().optional(),
        forkId: z.string().optional(),
        afterForkId: z.string().nullable().optional(),
      },
    },
    tool(async (input: Record<string, unknown>) => {
      const { explorationId } = requireAttachment();
      return json(
        await request(`/api/internal/explorations/${explorationId}/board`, {
          json: { shimId, ...input },
        }),
      );
    }),
  );

  server.registerTool(
    'rename_note_category',
    {
      description:
        'Rename a category of a note group for all its notes at once, or remove it with `to` null (the notes stay in the group). Renaming to a name already used there merges the two.',
      inputSchema: { groupId: z.string(), from: z.string(), to: z.string().nullable() },
    },
    tool(async ({ groupId, from, to }: { groupId: string; from: string; to: string | null }) => {
      requireAttachment();
      return json(
        await request(`/api/internal/note-groups/${groupId}/rename-category`, {
          json: { shimId, from, to },
        }),
      );
    }),
  );

  server.registerTool(
    'reorder_note_group',
    {
      description:
        'Move a note group: after another group of the same chat, or to the start with afterGroupId null.',
      inputSchema: { groupId: z.string(), afterGroupId: z.string().nullable() },
    },
    tool(async ({ groupId, afterGroupId }: { groupId: string; afterGroupId: string | null }) => {
      requireAttachment();
      return json(
        await request(`/api/internal/note-groups/${groupId}/reorder`, {
          json: { shimId, afterGroupId },
        }),
      );
    }),
  );

  server.registerTool(
    'change_note_group',
    {
      description: 'Move a note to another group of the same exploration. It goes first there.',
      inputSchema: { noteId: z.string(), groupId: z.string() },
    },
    tool(async ({ noteId, groupId }: { noteId: string; groupId: string }) => {
      requireAttachment();
      return json(
        await request(`/api/internal/notes/${noteId}/group`, {
          method: 'PUT',
          json: { shimId, groupId },
        }),
      );
    }),
  );

  server.registerTool(
    'request_note_deletion',
    {
      description:
        'Ask the user to delete a note. You cannot delete notes yourself: the page shows the request and the user deletes or keeps the note. Returns at once.',
      inputSchema: { noteId: z.string() },
    },
    tool(async ({ noteId }: { noteId: string }) => {
      requireAttachment();
      return json(
        await request<Note>(`/api/internal/notes/${noteId}/deletion-request`, {
          json: { shimId },
        }),
      );
    }),
  );

  server.registerTool(
    'await_feedback',
    {
      description:
        'Wait for the user to submit comments or messages in the browser. Returns every fork awaiting an answer, with its unanswered user messages, the notes that need a topic from you, and the note groups with their topics. On "timeout" call it again; on "detached" or "deleted" stop.',
      inputSchema: {
        timeoutSeconds: z.number().int().positive().optional(),
      },
    },
    tool(async ({ timeoutSeconds }: { timeoutSeconds?: number | undefined }, signal) => {
      const { explorationId } = requireAttachment();
      const deadline = Date.now() + (timeoutSeconds ?? defaultFeedbackTimeoutSeconds) * 1000;
      while (true) {
        const waitMs = Math.max(1, Math.min(feedbackRoundMs, deadline - Date.now()));
        const result = await request<FeedbackResult>(
          `/api/internal/explorations/${explorationId}/feedback`,
          { json: { shimId, waitMs }, signal },
        );
        if (result.status === 'detached' || result.status === 'deleted') attachment = null;
        if (result.status !== 'timeout') return json(result);
        if (Date.now() >= deadline || signal.aborted) {
          return json({ ...result, next: keepListening });
        }
      }
    }),
  );

  const close = async () => {
    if (heartbeat) clearInterval(heartbeat);
    if (daemonReady) await request('/api/internal/detach', { json: { shimId } }).catch(() => {});
  };

  return { server, close, shimId };
}

export async function runShim(options: ShimOptions) {
  const shim = createShim(options);
  const transport = new StdioServerTransport();
  const exit = () => {
    void shim.close().finally(() => process.exit(0));
  };
  transport.onclose = exit;
  process.stdin.on('end', exit);
  process.on('SIGTERM', exit);
  process.on('SIGINT', exit);
  await shim.server.connect(transport);
}
