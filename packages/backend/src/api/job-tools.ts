import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import { StoreError } from '../store/errors.js';
import type { Job, RunStore } from '../store/runs.js';
import type { ChatStore } from '../store/store.js';
import type { RequestStore } from '../store/requests.js';
import { noteRequestNote, requestToolDescriptions } from '@chat-explorer/shared/request-tools.js';
import type { RequestAction } from '@chat-explorer/shared/requests.js';
import {
  coordinationActions,
  noteActions,
  noteToolShapes,
  requestToolShapes,
  type CoordinationTool,
  type RequestToolArgs,
} from './request-tools.js';
import {
  readNotesDescription,
  readNotesLimit,
  searchNotesDescription,
} from '@chat-explorer/shared/note-tools.js';

export interface JobToolsOptions {
  store: ChatStore;
  requests: RequestStore;
  runs: RunStore;
}

const defaultPageSize = 20;
const maxPageSize = 100;
const maxMessageChars = 100_000;

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

// Every tool works on the job's own chat; a note or fork of another chat looks like none at all.
function sameChat(job: Job, explorationId: string, what: string) {
  if (explorationId !== job.explorationId) throw new StoreError('not_found', `${what} not found.`);
}

function toolsFor(job: Job, { store, runs, requests }: JobToolsOptions) {
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
    'set_chat_summary',
    {
      description:
        "Set the chat's title and its one-sentence summary. Use it when you are told the chat has no title, and again when the chat's topic shifts.",
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
    server.registerTool(
      'draft_comment',
      {
        description:
          "Draft a comment in another fork of this chat, for the user to read, edit and send there. You can't send it: it stays a draft until the user does. Use it when something you found belongs in another fork's conversation.",
        inputSchema: {
          forkId: z.string(),
          text: z.string().min(1),
          messageId: z
            .string()
            .optional()
            .describe("The message it comments on; the fork's newest one by default"),
        },
      },
      tool(
        ({
          forkId,
          text,
          messageId,
        }: {
          forkId: string;
          text: string;
          messageId?: string | undefined;
        }) => {
          sameChat(job, store.forkExplorationId(forkId), `Fork ${forkId}`);
          const comment = store.draftComment(job.forkId, { forkId, messageId, body: text });
          return { commentId: comment.id, forkId, messageId: comment.messageId };
        },
      ),
    );
  }

  const ask = (action: RequestAction) => requests.request(job.forkId, 'fork', action);

  // The chat's coordinator: the main fork, when the user turned Coordination on.
  const fork = store.fork(job.forkId);
  if (fork.parentForkId === null && fork.coordination) {
    const describe = (name: CoordinationTool) => ({
      description: requestToolDescriptions[name],
      inputSchema: requestToolShapes[name],
    });
    server.registerTool(
      'request_fork',
      describe('request_fork'),
      tool((args: RequestToolArgs['request_fork']) => ask(coordinationActions.request_fork(args))),
    );
    server.registerTool(
      'request_message',
      describe('request_message'),
      tool((args: RequestToolArgs['request_message']) =>
        ask(coordinationActions.request_message(args)),
      ),
    );
    server.registerTool(
      'request_fork_settings',
      describe('request_fork_settings'),
      tool((args: RequestToolArgs['request_fork_settings']) =>
        ask(coordinationActions.request_fork_settings(args)),
      ),
    );
  }

  server.registerTool(
    'read_fork',
    {
      description:
        'Read a fork of this chat: its messages, oldest first, ending with its newest one. Pass the returned nextBefore as before to read further back. Messages longer than maxChars (2,000 by default) are cut, marked truncated.',
      inputSchema: {
        forkId: z.string(),
        limit: z.number().int().min(1).max(maxPageSize).optional(),
        before: z.string().optional(),
        maxChars: z
          .number()
          .int()
          .min(0)
          .max(maxMessageChars)
          .optional()
          .describe(
            'Cut each message at this many characters instead, or not at all with 0. The page then holds fewer messages, so it stays within a tool result.',
          ),
      },
    },
    tool(
      ({
        forkId,
        limit,
        before,
        maxChars,
      }: {
        forkId: string;
        limit?: number | undefined;
        before?: string | undefined;
        maxChars?: number | undefined;
      }) => {
        sameChat(job, store.forkExplorationId(forkId), `Fork ${forkId}`);
        if (!aware && forkId !== job.forkId) {
          throw new StoreError('not_found', `This fork reads only itself, not fork ${forkId}.`);
        }
        return store.readForkPage(forkId, { limit: limit ?? defaultPageSize, before, maxChars });
      },
    ),
  );

  server.registerTool(
    'list_notes',
    {
      description:
        "The chat's notes as an index: each group with its notes' ids, topics, text length and last change, without their text. Read the text of the notes you need with read_notes, or find notes by their words with search_notes.",
      inputSchema: { groupId: z.string().optional() },
    },
    tool(({ groupId }: { groupId?: string | undefined }) =>
      store.listNotes(job.explorationId, groupId),
    ),
  );

  server.registerTool(
    'read_notes',
    {
      description: `${readNotesDescription} Notes that would make the result too long come back in notShown, to read in another call.`,
      inputSchema: { noteIds: z.array(z.string()).min(1).max(readNotesLimit) },
    },
    tool(({ noteIds }: { noteIds: string[] }) => store.readNotes(job.explorationId, noteIds)),
  );

  server.registerTool(
    'search_notes',
    {
      description: searchNotesDescription,
      inputSchema: { query: z.string().min(1) },
    },
    tool(({ query }: { query: string }) => store.searchNotes(job.explorationId, query)),
  );

  // Writing notes and changing the board wait for the user's approval on a card in this fork,
  // unless the fork's Autonomous setting covers them; the result says which.
  const waits = ` ${noteRequestNote}`;

  server.registerTool(
    'add_note_group',
    {
      description: `Create a note group. A checklist group lets the user tick its notes, as for a shopping list. The result names the group's id, so notes can go into it in the same card.${waits}`,
      inputSchema: noteToolShapes.add_note_group,
    },
    tool((args: RequestToolArgs['add_note_group']) => ask(noteActions.add_note_group(args))),
  );

  server.registerTool(
    'add_notes',
    {
      description: `Add notes to a group, at the end of the group (or of their category) in the order given. Each needs a topic (a short title) or a description (markdown), and may name a category: a section of the group, shown as a heading above its notes. Pass sourceMessageId, the id of the user's message that asked for them, so each note links back to it.${waits}`,
      inputSchema: noteToolShapes.add_notes,
    },
    tool((args: RequestToolArgs['add_notes']) => ask(noteActions.add_notes(args))),
  );

  server.registerTool(
    'update_note',
    {
      description: `Change a note's topic, description or category (null removes it), or tick it (checked) in a checklist group.${waits}`,
      inputSchema: noteToolShapes.update_note,
    },
    tool((args: RequestToolArgs['update_note']) => ask(noteActions.update_note(args))),
  );

  server.registerTool(
    'list_board',
    {
      description:
        'Read the board of forks: the columns left to right with their forks top to bottom, then the Ungrouped forks. The main fork is not on the board.',
      inputSchema: {},
    },
    tool(() => store.boardOverview(job.explorationId)),
  );

  server.registerTool(
    'arrange_board',
    {
      description: `Change the board of forks, one action at a time. Name a column by its id or its name. add_column needs \`name\`; rename_column needs \`column\` and \`name\`; delete_column needs \`column\` (its forks go to Ungrouped); move_column needs \`column\` and, to put it after another, \`afterColumn\` (null: first); move_fork needs \`forkId\` and \`column\` (null: Ungrouped) and puts the fork last in it, or after \`afterForkId\` (null: first). Archiving keeps a fork in its column.${waits}`,
      inputSchema: noteToolShapes.arrange_board,
    },
    tool((args: RequestToolArgs['arrange_board']) => ask(noteActions.arrange_board(args))),
  );

  server.registerTool(
    'rename_note_category',
    {
      description: `Rename a category of a note group for all its notes at once, or remove it with \`to\` null (the notes stay in the group). Renaming to a name already used there merges the two.${waits}`,
      inputSchema: noteToolShapes.rename_note_category,
    },
    tool((args: RequestToolArgs['rename_note_category']) =>
      ask(noteActions.rename_note_category(args)),
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
    'reorder_note_group',
    {
      description:
        'Move a note group: after another group of the same chat, or to the start with afterGroupId null.',
      inputSchema: { groupId: z.string(), afterGroupId: z.string().nullable() },
    },
    tool(({ groupId, afterGroupId }: { groupId: string; afterGroupId: string | null }) => {
      sameChat(job, store.noteGroupExplorationId(groupId), `Note group ${groupId}`);
      return store.reorderNoteGroup(groupId, afterGroupId);
    }),
  );

  server.registerTool(
    'change_note_group',
    {
      description: `Move a note to another group of this chat. It goes first there.${waits}`,
      inputSchema: noteToolShapes.change_note_group,
    },
    tool((args: RequestToolArgs['change_note_group']) => ask(noteActions.change_note_group(args))),
  );

  server.registerTool(
    'request_note_deletion',
    {
      description: `Ask to delete a note. Approving the card deletes it.${waits}`,
      inputSchema: noteToolShapes.request_note_deletion,
    },
    tool((args: RequestToolArgs['request_note_deletion']) =>
      ask(noteActions.request_note_deletion(args)),
    ),
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
