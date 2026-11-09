import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import { StoreError } from '../store/errors.js';
import type { Job, RunStore } from '../store/runs.js';
import type { ChatStore } from '../store/store.js';

export interface JobToolsOptions {
  store: ChatStore;
  runs: RunStore;
}

const defaultPageSize = 20;
const maxPageSize = 100;

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

// Every tool works on the job's own chat; a note or fork of another chat looks like none at all.
function sameChat(job: Job, explorationId: string, what: string) {
  if (explorationId !== job.explorationId) throw new StoreError('not_found', `${what} not found.`);
}

function toolsFor(job: Job, { store, runs }: JobToolsOptions) {
  const server = new McpServer({ name: 'chat-explorer-job', version: '1.0.0' });
  const tool =
    <Args>(handler: (args: Args) => unknown) =>
    async (args: Args): Promise<CallToolResult> => {
      try {
        return json(await handler(args));
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    };
  const noteInChat = (noteId: string) => {
    sameChat(job, store.noteExplorationId(noteId), `Note ${noteId}`);
    return noteId;
  };

  server.registerTool(
    'answer',
    {
      description:
        "Post a message in this fork right away and keep working: for a quick question that came in while you work on a longer one, so it isn't kept waiting. Start each part with the tags of what it answers. Your reply at the end of the turn is posted too, so don't repeat what you posted here.",
      inputSchema: { text: z.string().min(1) },
    },
    tool(({ text }: { text: string }) => {
      const message = runs.answer(job.forkId, job.leaseId, text);
      return { messageId: message.id };
    }),
  );

  server.registerTool(
    'set_fork_summary',
    {
      description: 'Set the one-line summary of this fork, shown on the map. Under 60 characters.',
      inputSchema: { summary: z.string().min(1) },
    },
    tool(({ summary }: { summary: string }) =>
      store.updateForkSummary({ forkId: job.forkId, summary }),
    ),
  );

  server.registerTool(
    'update_chat',
    {
      description: "Set the chat's title and its one-sentence summary.",
      inputSchema: { title: z.string().optional(), summary: z.string().optional() },
    },
    tool((changes: { title?: string | undefined; summary?: string | undefined }) =>
      store.updateExploration({ explorationId: job.explorationId, ...changes }),
    ),
  );

  // A separate fork hears nothing of the others: it can read only itself.
  const aware = store.fork(job.forkId).awareness === 'aware';
  if (aware) {
    server.registerTool(
      'list_forks',
      {
        description:
          "The chat's fork tree: every fork's id, parent, summary, message count and whether it waits for an answer.",
        inputSchema: {},
      },
      tool(() => ({ forks: store.forkMap(job.explorationId) })),
    );
  }

  server.registerTool(
    'read_fork',
    {
      description:
        'Read a fork of this chat: its messages, oldest first, ending with its newest one. Pass the returned nextBefore as before to read further back. Long messages are cut, marked truncated.',
      inputSchema: {
        forkId: z.string(),
        limit: z.number().int().min(1).max(maxPageSize).optional(),
        before: z.string().optional(),
      },
    },
    tool(
      ({
        forkId,
        limit,
        before,
      }: {
        forkId: string;
        limit?: number | undefined;
        before?: string | undefined;
      }) => {
        sameChat(job, store.forkExplorationId(forkId), `Fork ${forkId}`);
        if (!aware && forkId !== job.forkId) {
          throw new StoreError('not_found', `This fork reads only itself, not fork ${forkId}.`);
        }
        return store.readForkPage(forkId, { limit: limit ?? defaultPageSize, before });
      },
    ),
  );

  server.registerTool(
    'list_notes',
    {
      description: "Read the chat's notes in full: every group with its notes in order.",
      inputSchema: { groupId: z.string().optional() },
    },
    tool(({ groupId }: { groupId?: string | undefined }) =>
      store.readNotes(job.explorationId, groupId),
    ),
  );

  server.registerTool(
    'add_note_group',
    {
      description:
        'Create a note group. A checklist group lets the user tick its notes, as for a shopping list.',
      inputSchema: { name: z.string().optional(), checklist: z.boolean().optional() },
    },
    tool((group: { name?: string | undefined; checklist?: boolean | undefined }) =>
      store.createNoteGroup(job.explorationId, group),
    ),
  );

  server.registerTool(
    'add_notes',
    {
      description:
        "Add notes to a group, first in the group in the order given. Each needs a topic (a short title) or a description (markdown). Pass sourceMessageId, the id of the user's message that asked for them, so each note links back to it.",
      inputSchema: {
        groupId: z.string(),
        notes: z
          .array(z.object({ topic: z.string().optional(), description: z.string().optional() }))
          .min(1),
        sourceMessageId: z.string().optional(),
      },
    },
    tool(
      (input: {
        groupId: string;
        notes: { topic?: string | undefined; description?: string | undefined }[];
        sourceMessageId?: string | undefined;
      }) => store.addNotes({ explorationId: job.explorationId, ...input }),
    ),
  );

  server.registerTool(
    'update_note',
    {
      description:
        "Change a note's topic or description, or tick it (checked) in a checklist group.",
      inputSchema: {
        noteId: z.string(),
        topic: z.string().optional(),
        description: z.string().optional(),
        checked: z.boolean().optional(),
      },
    },
    tool(
      ({
        noteId,
        ...changes
      }: {
        noteId: string;
        topic?: string | undefined;
        description?: string | undefined;
        checked?: boolean | undefined;
      }) => store.updateNote(noteInChat(noteId), changes),
    ),
  );

  server.registerTool(
    'reorder_note',
    {
      description:
        'Move a note within its group: after another note of the same group, or to the top with afterNoteId null.',
      inputSchema: { noteId: z.string(), afterNoteId: z.string().nullable() },
    },
    tool(({ noteId, afterNoteId }: { noteId: string; afterNoteId: string | null }) =>
      store.reorderNote(noteInChat(noteId), afterNoteId),
    ),
  );

  server.registerTool(
    'change_note_group',
    {
      description: 'Move a note to another group of this chat. It goes first there.',
      inputSchema: { noteId: z.string(), groupId: z.string() },
    },
    tool(({ noteId, groupId }: { noteId: string; groupId: string }) =>
      store.changeNoteGroup(noteInChat(noteId), groupId),
    ),
  );

  server.registerTool(
    'request_note_deletion',
    {
      description:
        'Ask the user to delete a note. You cannot delete notes yourself: the page shows the request and the user deletes or keeps the note.',
      inputSchema: { noteId: z.string() },
    },
    tool(({ noteId }: { noteId: string }) => store.requestNoteDeletion(noteInChat(noteId))),
  );

  return server;
}

// The tools an engine calls during a run, over MCP, with the tools token of its lease. A fresh,
// stateless server per request: the token alone says which job it is.
export function registerJobTools(app: Hono, options: JobToolsOptions) {
  app.all('/api/tools/mcp', async (context) => {
    const token = context.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    const job = token ? options.runs.jobForToolsToken(token) : null;
    if (!job)
      return context.json({ error: 'unauthorized', message: 'No job for this token.' }, 401);
    const server = toolsFor(job, options);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(context.req.raw);
  });
}
