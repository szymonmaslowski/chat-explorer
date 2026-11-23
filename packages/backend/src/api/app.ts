import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { apiVersion } from '@chat-explorer/shared/config.js';
import { dictationHint, type Transcriber } from '../dictation/transcriber.js';
import type { FileStorage } from '../files/file-storage.js';
import { maxFileBytes } from '../files/kinds.js';
import { findTranscript, readTranscript } from '../import/transcript.js';
import type { Speaker } from '../speech/speaker.js';
import { prefixedIdPattern } from '@chat-explorer/shared/ids.js';
import { withLegacyIdsPrefixed } from './legacy-ids.js';
import { claudeModels, type ClaudeModel } from '@chat-explorer/shared/models.js';
import {
  credentialNamePattern,
  isHostPort,
  maxAllowedHosts,
  maxCredentials,
  registryNames,
} from '@chat-explorer/shared/network.js';
import {
  chatDefaultPages,
  type ChangeSet,
  type ExplorationListItem,
  type ExplorationView,
  type LightSnapshot,
  type Snapshot,
} from '@chat-explorer/shared/types.js';
import { StoreError } from '../store/errors.js';
import { newId } from '../store/ids.js';
import type { EventBus } from '../store/event-bus.js';
import type { FeedbackHub } from '../store/feedback-hub.js';
import type { RunStore } from '../store/runs.js';
import type { ChatStore } from '../store/store.js';
import { RequestStore } from '../store/requests.js';
import { requestDecisionSchema } from './request-schemas.js';
import { guardLocalRequests } from './guard.js';
import { registerJobTools } from './job-tools.js';
import { registerRunnerRoutes } from './runner-routes.js';
import { serveUi } from './static-ui.js';
import { ProgressLines } from '../store/progress-lines.js';

export interface AppOptions {
  store: ChatStore;
  hub: FeedbackHub;
  bus: EventBus;
  runs: RunStore;
  machineToken: string;
  transcriber: Transcriber;
  speaker: Speaker;
  fileStorage: FileStorage;
  defaultModel: ClaudeModel;
  port: number;
  publicUrl: string | null;
  version: string;
  uiDirectory: string | null;
  onShutdown: () => void;
}

const sseKeepAliveMs = 20_000;
const maxFeedbackWaitMs = 280_000;
// About ten minutes of 16 kHz mono 16-bit WAV.
const maxRecordingBytes = 20 * 1024 * 1024;

const commentType = z.enum(['inline', 'fork', 'note']);
const model = z.enum(claudeModels);
const fileIds = z.array(z.string()).default([]);
const newExplorationBody = z
  .object({
    message: z.string().trim().default(''),
    model: model.optional(),
    fileIds,
    archived: z.boolean().default(false),
  })
  .refine((body) => body.message || body.fileIds.length > 0, 'Write a message or attach a file.');
const explorationSettingsBody = z
  .object({ model: model.optional(), defaultPage: z.enum(chatDefaultPages).optional() })
  .refine((settings) => settings.model || settings.defaultPage, 'Nothing to change');
const columnNameBody = z.object({ name: z.string() });
const afterColumnBody = z.object({ afterColumnId: z.string().nullable() });
const moveForkBody = z.object({
  columnId: z.string().nullable(),
  afterForkId: z.string().nullable(),
});
const clientId = z.string().regex(prefixedIdPattern).optional();
const newCommentBody = z.object({
  id: clientId,
  messageId: z.string(),
  viewForkId: z.string(),
  quote: z.string(),
  startOffset: z.number().int(),
  endOffset: z.number().int(),
  body: z.string().default(''),
  editBody: z.string().optional(),
  type: commentType.optional(),
  noteGroupId: z.string().min(1).nullable().optional(),
  fileIds: z.array(z.string()).optional(),
  selected: z.boolean().optional(),
  boardColumnChoice: z.string().min(1).nullable().optional(),
});
const forkGroupBody = z.object({ memberIds: z.array(z.string()), groupId: clientId });
const commentChangesBody = z.object({
  body: z.string().optional(),
  editBody: z.string().nullable().optional(),
  type: commentType.optional(),
  noteGroupId: z.string().min(1).nullable().optional(),
  fileIds: z.array(z.string()).optional(),
  selected: z.boolean().optional(),
  boardColumnChoice: z.string().min(1).nullable().optional(),
});
const replyDraftBody = z.object({
  text: z.string(),
  newFork: z.boolean(),
  boardColumnChoice: z.string().min(1).nullable().default(null),
  fileIds,
});
const submitBody = z.object({
  id: clientId,
  forkId: z.string(),
  globalMessage: z.string().default(''),
  newFork: z.boolean().default(false),
  boardColumnChoice: z.string().min(1).nullable().default(null),
  fileIds,
});
const forkNowBody = z.object({ id: clientId });
const maxBodiesPerRequest = 200;
const messageBodiesQuery = z.object({
  ids: z
    .string()
    .transform((ids) => ids.split(',').filter(Boolean))
    .pipe(z.array(z.string()).min(1).max(maxBodiesPerRequest)),
});
const changesQuery = z.object({ after: z.coerce.number().int().min(0) });
const attemptQuery = z.object({
  forkId: z.string(),
  afterMessageId: z.string(),
  attempt: z.coerce.number().int(),
});
const deviceCookie = 'ce_device';
const deviceOf = (context: Context) => getCookie(context, deviceCookie)?.split('.')[0] ?? null;
const markedAt = z.number().int().positive().optional();
const readMessagesBody = z.object({ messageIds: z.array(z.string()).min(1), at: markedAt });
const unreadFromBody = z.object({ viewForkId: z.string(), at: markedAt });
const noteForkBody = z.object({ id: clientId, forkId: clientId, message: z.string() });
const answerForkBody = z.object({ forkId: clientId });
const forkAwarenessBody = z.object({ awareness: z.enum(['aware', 'separate']) });
const forkCodingBody = z.object({ coding: z.boolean() });
const forkModelBody = z.object({ model: model.nullable() });
const forkNetworkBody = z.object({
  hosts: z
    .array(z.string().refine(isHostPort, 'Write each host as name:port, such as github.com:443.'))
    .max(maxAllowedHosts)
    .transform((hosts) => [...new Set(hosts)]),
  registries: z.array(z.enum(registryNames)).transform((names) => [...new Set(names)]),
  credentials: z
    .array(z.string().regex(credentialNamePattern, 'Not a credential name.'))
    .max(maxCredentials)
    .transform((names) => [...new Set(names)])
    .optional(),
});
const newBookmarkBody = z.object({
  id: clientId,
  forkId: z.string(),
  messageId: z.string(),
  quote: z.string().min(1),
  startOffset: z.number().int(),
  endOffset: z.number().int(),
});
const newNoteGroupBody = z.object({
  id: clientId,
  name: z.string().optional(),
  checklist: z.boolean().optional(),
});
const noteGroupChangesBody = z.object({
  name: z.string().optional(),
  checklist: z.boolean().optional(),
});
const newNoteBody = z.object({
  id: clientId,
  groupId: z.string(),
  topic: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
});
const noteChangesBody = z.object({
  topic: z.string().optional(),
  description: z.string().optional(),
  category: z.string().nullable().optional(),
  checked: z.boolean().optional(),
  baseUpdatedAt: z.number().int().optional(),
  editedAt: z.number().int().optional(),
});
const noteReorderBody = z.object({ afterNoteId: z.string().nullable() });
const noteGroupReorderBody = z.object({ afterGroupId: z.string().nullable() });
const categoryRenameBody = z.object({ from: z.string(), to: z.string().nullable() });
const noteGroupBody = z.object({ groupId: z.string() });
const uploadBody = z.object({ file: z.instanceof(File) });
// Multipart framing around a file at the size limit.
const uploadOverheadBytes = 64 * 1024;
const shimBody = z.object({ shimId: z.string() });
const arrangeBoardShape = {
  action: z.enum(['add_column', 'rename_column', 'delete_column', 'move_column', 'move_fork']),
  column: z.string().nullable().optional(),
  name: z.string().optional(),
  afterColumn: z.string().nullable().optional(),
  forkId: z.string().optional(),
  afterForkId: z.string().nullable().optional(),
};
const arrangeBoardBody = shimBody.extend(arrangeBoardShape);
const startExplorationBody = shimBody.extend({
  sessionId: z.string(),
  transcriptPath: z.string().endsWith('.jsonl').optional(),
  title: z.string().optional(),
});
const attachBody = shimBody.extend({ sessionId: z.string(), takeover: z.boolean().default(false) });
const addMessageBody = shimBody.extend({ inReplyTo: z.string(), content: z.string().min(1) });
const forkSummaryBody = shimBody.extend({ summary: z.string() });
const supervisorMessageBody = shimBody.extend({ text: z.string().min(1) });
const sessionStepBody = z.object({
  texts: z.array(z.string().min(1)).default([]),
  tool: z.string().min(1).nullable().default(null),
});
const explorationChangesBody = shimBody.extend({
  title: z.string().optional(),
  summary: z.string().optional(),
});
const transcriptionBody = z.object({
  audio: z.instanceof(File),
  hint: z.string().default(''),
});
// A paragraph is far shorter; this only keeps one request from tying up `say` for minutes.
const maxSpeechTextLength = 10_000;
const speechBlock = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(maxSpeechTextLength) }),
  z.object({
    kind: z.literal('code'),
    language: z.string().max(40),
    lines: z.number().int().min(0),
  }),
  z.object({ kind: z.literal('diagram') }),
  z.object({
    kind: z.literal('table'),
    columns: z.number().int().min(0),
    rows: z.number().int().min(0),
  }),
  z.object({ kind: z.literal('image'), description: z.string().max(maxSpeechTextLength) }),
]);
// A block of a message, or of other text (a draft, a note); the whole text picks the voice. Only
// the block is spoken, so the whole text may be as long as a long note.
const speechBody = z.union([
  z.object({ messageId: z.string(), block: speechBlock }),
  z.object({ text: z.string(), block: speechBlock }),
]);
const claudeNoteGroupBody = shimBody.extend({
  name: z.string().optional(),
  checklist: z.boolean().optional(),
});
const claudeNotesBody = shimBody.extend({
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
});
const claudeNoteChangesBody = shimBody.extend(noteChangesBody.shape);
const claudeCategoryRenameBody = shimBody.extend(categoryRenameBody.shape);
const claudeNoteReorderBody = shimBody.extend(noteReorderBody.shape);
const claudeNoteGroupReorderBody = shimBody.extend(noteGroupReorderBody.shape);
const claudeNoteGroupChangeBody = shimBody.extend(noteGroupBody.shape);
const feedbackBody = shimBody.extend({
  waitMs: z.number().int().positive().max(maxFeedbackWaitMs),
});

type SendEvent = (event: string, data: object) => void;

function eventStream(context: Context, subscribe: (send: SendEvent) => () => void) {
  return streamSSE(context, async (stream) => {
    const unsubscribe = subscribe((event, data) => {
      void stream.writeSSE({ event, data: JSON.stringify(data) });
    });
    stream.onAbort(unsubscribe);
    await stream.writeSSE({ event: 'ready', data: '{}' });
    while (!stream.aborted && !stream.closed) {
      await stream.sleep(sseKeepAliveMs);
      await stream.writeSSE({ event: 'ping', data: '' });
    }
    unsubscribe();
  });
}

export function createApp(options: AppOptions) {
  const progressLines = new ProgressLines();
  const { store, hub, bus, transcriber, speaker, fileStorage, port } = options;
  const localUrl = `http://127.0.0.1:${port}`;
  const explorationUrls = (explorationId: string) => ({
    url: `${options.publicUrl ?? localUrl}/e/${explorationId}`,
    localUrl: `${localUrl}/e/${explorationId}`,
  });
  const app = new Hono();
  const requests = new RequestStore(
    store,
    () => options.runs.lastCapabilities()?.capabilities ?? null,
  );

  app.use('*', guardLocalRequests(port, options.publicUrl));
  // A long chat's snapshot is megabytes of JSON, loaded again on every reconnect over the
  // tailnet. Event streams are left as they are, so each event arrives at once.
  app.use('*', compress());
  // Each browser gets an id that outlives what the page keeps: set by the server, so Safari's
  // seven-day limit on what pages store does not clear it, and renewed on each visit, as browsers
  // keep a cookie for 400 days at most. It tells the page its offline copy was cleared, and the
  // daemon which device made an edit.
  app.use('*', async (context, next) => {
    const device = getCookie(context, deviceCookie) ?? `${newId()}.${Date.now()}`;
    setCookie(context, deviceCookie, device, {
      path: '/',
      maxAge: 400 * 24 * 60 * 60,
      sameSite: 'Strict',
    });
    await next();
  });

  app.onError((error, context) => {
    if (error instanceof StoreError) {
      return context.json({ error: error.code, message: error.message }, error.httpStatus);
    }
    if (error instanceof z.ZodError) {
      return context.json({ error: 'invalid', message: z.prettifyError(error) }, 400);
    }
    console.error(error);
    return context.json({ error: 'internal', message: 'Internal error' }, 500);
  });

  registerRunnerRoutes(app, {
    store,
    requests,
    runs: options.runs,
    bus,
    machineToken: options.machineToken,
  });
  registerJobTools(app, { store, runs: options.runs, requests });

  // The user's decision on a card of requested actions: approve the ticked items, edited, or
  // reject them all.
  app.post('/api/requests/:id/decide', async (context) => {
    const decision = requestDecisionSchema.parse(await context.req.json());
    return context.json(requests.decide(context.req.param('id'), decision));
  });

  app.patch('/api/forks/:id/awareness', async (context) => {
    const { awareness } = forkAwarenessBody.parse(await context.req.json());
    return context.json(store.setForkAwareness(context.req.param('id'), awareness));
  });

  app.patch('/api/forks/:id/coding', async (context) => {
    const { coding } = forkCodingBody.parse(await context.req.json());
    return context.json(store.setForkCoding(context.req.param('id'), coding));
  });

  app.patch('/api/forks/:id/model', async (context) => {
    const { model } = forkModelBody.parse(await context.req.json());
    return context.json(store.setForkModel(context.req.param('id'), model));
  });

  app.patch('/api/forks/:id/network', async (context) => {
    const forkId = context.req.param('id');
    const { credentials, ...rest } = forkNetworkBody.parse(await context.req.json());
    // A page loaded before credentials existed leaves them as they are.
    const kept = credentials ?? store.fork(forkId).network.credentials;
    return context.json(store.setForkNetwork(forkId, { ...rest, credentials: kept }));
  });

  app.post('/api/forks/:id/restart-container', (context) =>
    context.json({ restarting: options.runs.requestRestart(context.req.param('id')) }),
  );

  app.post('/api/forks/:id/stop', (context) =>
    context.json({ stopping: options.runs.requestStop(context.req.param('id')) }),
  );

  app.post('/api/forks/:id/retry', (context) => {
    options.runs.retry(context.req.param('id'));
    return context.json({ ok: true });
  });

  // For the composer of a coding fork, to say before sending when the fork would wait for memory.
  app.get('/api/coding-capacity', (context) =>
    context.json({ capacity: options.runs.currentCodingCapacity() }),
  );

  // What the runner offers coding forks, for the fork's settings to show. Display only.
  app.get('/api/runner-capabilities', (context) =>
    context.json({ report: options.runs.lastCapabilities() }),
  );

  app.get('/api/health', (context) =>
    context.json({ name: 'chat-explorer', version: options.version, apiVersion, pid: process.pid }),
  );

  app.post('/api/shutdown', (context) => {
    setImmediate(options.onShutdown);
    return context.json({ ok: true });
  });

  app.get('/api/settings', (context) =>
    context.json({
      defaultModel: options.defaultModel,
      dictation: transcriber.available(),
      speech: speaker.available(),
    }),
  );

  app.post('/api/speech', async (context) => {
    const body = speechBody.parse(await context.req.json());
    const { audio, contentType } = await speaker.speak({
      ...('messageId' in body
        ? { messageId: body.messageId, content: store.messageContent(body.messageId) }
        : { messageId: null, content: body.text }),
      block: body.block,
      signal: context.req.raw.signal,
    });
    return context.body(audio, 200, { 'content-type': contentType });
  });

  app.post(
    '/api/transcriptions',
    bodyLimit({
      maxSize: maxRecordingBytes,
      onError: (context) =>
        context.json({ error: 'too_large', message: 'The recording is too long.' }, 413),
    }),
    async (context) => {
      const { audio, hint } = transcriptionBody.parse(await context.req.parseBody());
      const text = await transcriber.transcribe({
        wav: new Uint8Array(await audio.arrayBuffer()),
        hint: dictationHint(hint),
        signal: context.req.raw.signal,
      });
      return context.json({ text });
    },
  );

  app.get('/api/explorations', (context) => {
    const view: ExplorationView =
      context.req.query('deleted') === 'true'
        ? 'deleted'
        : context.req.query('archived') === 'true'
          ? 'archived'
          : 'active';
    const explorations: ExplorationListItem[] = store.listExplorations(view).map((exploration) => ({
      ...exploration,
      sessionStatus: view === 'deleted' ? 'detached' : hub.status(exploration.id),
    }));
    return context.json(explorations);
  });

  app.post('/api/explorations', async (context) => {
    const body = newExplorationBody.parse(await context.req.json());
    const { exploration, mainFork } = store.createExploration({
      model: body.model ?? options.defaultModel,
      archived: body.archived,
    });
    store.submit(exploration.id, mainFork.id, body.message, { fileIds: body.fileIds });
    return context.json({ explorationId: exploration.id }, 201);
  });

  app.post(
    '/api/files',
    bodyLimit({
      maxSize: maxFileBytes + uploadOverheadBytes,
      onError: (context) =>
        context.json({ error: 'too_large', message: 'The file is larger than 10 MB.' }, 413),
    }),
    async (context) => {
      const { file } = uploadBody.parse(await context.req.parseBody());
      const uploaded = await fileStorage.add({
        name: file.name,
        mediaType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      return context.json(uploaded, 201);
    },
  );

  // Text goes out as plain text, so an uploaded HTML file is shown, never run.
  app.get('/api/files/:id', (context) => {
    const row = store.fileRow(context.req.param('id'));
    const contentType = row.kind === 'text' ? 'text/plain; charset=utf-8' : row.media_type;
    return context.body(Readable.toWeb(createReadStream(row.path)) as ReadableStream, 200, {
      'content-type': contentType,
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=31536000, immutable',
    });
  });

  app.delete('/api/files/:id', async (context) => {
    await fileStorage.removeDraft(context.req.param('id'));
    return context.json({ ok: true });
  });

  app.get('/api/explorations/:id', (context) => {
    const explorationId = context.req.param('id');
    if (context.req.query('light') !== undefined) {
      const light: LightSnapshot = {
        ...store.lightSnapshot(explorationId),
        sessionStatus: hub.status(explorationId),
      };
      return context.json(light);
    }
    const snapshot: Snapshot = {
      ...store.snapshot(explorationId),
      sessionStatus: hub.status(explorationId),
    };
    return context.json(snapshot);
  });

  app.get('/api/explorations/:id/changes', (context) => {
    const explorationId = context.req.param('id');
    const { after } = changesQuery.parse(context.req.query());
    const changes: ChangeSet = {
      ...store.changesSince(explorationId, after),
      sessionStatus: hub.status(explorationId),
    };
    return context.json(changes);
  });

  app.get('/api/explorations/:id/message-bodies', (context) => {
    const { ids } = messageBodiesQuery.parse(context.req.query());
    return context.json(store.messageBodies(context.req.param('id'), ids));
  });

  app.get('/api/explorations/:id/activities', (context) => {
    const attempt = attemptQuery.parse(context.req.query());
    return context.json(store.attemptActivities(context.req.param('id'), attempt));
  });

  app.patch('/api/explorations/:id', async (context) => {
    const explorationId = context.req.param('id');
    const settings = explorationSettingsBody.parse(await context.req.json());
    let exploration = settings.defaultPage
      ? store.setDefaultPage(explorationId, settings.defaultPage)
      : undefined;
    if (settings.model) {
      exploration = store.setModel(explorationId, settings.model);
    }
    return context.json(exploration);
  });

  app.post('/api/explorations/:id/archive', (context) =>
    context.json(store.archiveExploration(context.req.param('id'))),
  );

  app.post('/api/explorations/:id/unarchive', (context) =>
    context.json(store.unarchiveExploration(context.req.param('id'))),
  );

  app.post('/api/explorations/:id/restore', (context) =>
    context.json(store.restoreExploration(context.req.param('id'))),
  );

  app.delete('/api/explorations/:id', async (context) => {
    const explorationId = context.req.param('id');
    if (context.req.query('purge') === 'true') {
      const paths = store.filePathsOf(explorationId);
      store.purgeExploration(explorationId);
      await fileStorage.removeFiles(paths);
    } else {
      store.deleteExploration(explorationId);
    }
    return context.json({ ok: true });
  });

  app.post('/api/explorations/:id/read', async (context) => {
    const body = readMessagesBody.parse(await context.req.json());
    return context.json(store.markRead(context.req.param('id'), body.messageIds, body.at));
  });

  app.post('/api/messages/:id/unread', async (context) => {
    const body = unreadFromBody.parse(await context.req.json());
    return context.json(store.markUnreadFrom(context.req.param('id'), body.viewForkId, body.at));
  });

  app.post('/api/explorations/:id/comments', async (context) => {
    const body = newCommentBody.parse(await context.req.json());
    return context.json(store.createComment(context.req.param('id'), body), 201);
  });

  app.patch('/api/comments/:id', async (context) => {
    const body = commentChangesBody.parse(await context.req.json());
    return context.json(store.updateComment(context.req.param('id'), body));
  });

  app.delete('/api/comments/:id', (context) => {
    store.deleteComment(context.req.param('id'));
    return context.json({ ok: true });
  });

  app.put('/api/comments/:id/fork-group', async (context) => {
    const body = forkGroupBody.parse(await context.req.json());
    return context.json(store.joinForkGroup(context.req.param('id'), body));
  });

  app.delete('/api/comments/:id/fork-group', (context) =>
    context.json(store.leaveForkGroup(context.req.param('id'))),
  );

  app.delete('/api/fork-groups/:id', (context) =>
    context.json(store.ungroupForkGroup(context.req.param('id'))),
  );

  app.post('/api/comments/:id/fork-now', async (context) => {
    const { id } = forkNowBody.parse(await context.req.json());
    return context.json(store.forkNow(context.req.param('id'), { id }), 201);
  });

  app.post('/api/explorations/:id/submit', async (context) => {
    const { id, forkId, globalMessage, newFork, boardColumnChoice, fileIds } = submitBody.parse(
      await context.req.json(),
    );
    return context.json(
      store.submit(context.req.param('id'), forkId, globalMessage, {
        id,
        newFork,
        boardColumnChoice,
        fileIds,
      }),
      201,
    );
  });

  app.post('/api/forks/:id/archive', (context) =>
    context.json(store.archiveFork(context.req.param('id'))),
  );

  app.post('/api/forks/:id/unarchive', (context) =>
    context.json(store.unarchiveFork(context.req.param('id'))),
  );

  app.post('/api/forks/:id/collapse', (context) =>
    context.json(store.collapseFork(context.req.param('id'))),
  );

  app.post('/api/forks/:id/expand-children', (context) =>
    context.json(store.expandCollapsedChildren(context.req.param('id'))),
  );

  app.post('/api/explorations/:id/board-columns', async (context) => {
    const { name } = columnNameBody.parse(await context.req.json());
    return context.json(store.addBoardColumn(context.req.param('id'), name), 201);
  });

  app.patch('/api/explorations/:id/board-columns/:columnId', async (context) => {
    const { name } = columnNameBody.parse(await context.req.json());
    return context.json(
      store.renameBoardColumn(context.req.param('id'), context.req.param('columnId'), name),
    );
  });

  app.post('/api/explorations/:id/board-columns/:columnId/reorder', async (context) => {
    const { afterColumnId } = afterColumnBody.parse(await context.req.json());
    return context.json(
      store.reorderBoardColumn(
        context.req.param('id'),
        context.req.param('columnId'),
        afterColumnId,
      ),
    );
  });

  app.delete('/api/explorations/:id/board-columns/:columnId', (context) =>
    context.json(store.deleteBoardColumn(context.req.param('id'), context.req.param('columnId'))),
  );

  app.post('/api/forks/:id/move', async (context) => {
    const { columnId, afterForkId } = moveForkBody.parse(await context.req.json());
    return context.json(store.moveFork(context.req.param('id'), columnId, afterForkId));
  });

  app.get('/api/forks/:id/reply-draft', (context) =>
    context.json(store.replyDraft(context.req.param('id'))),
  );

  app.put('/api/forks/:id/reply-draft', async (context) => {
    const draft = replyDraftBody.parse(await context.req.json());
    return context.json(store.saveReplyDraft(context.req.param('id'), draft));
  });

  app.post('/api/explorations/:id/bookmarks', async (context) => {
    const body = newBookmarkBody.parse(await context.req.json());
    return context.json(store.createBookmark(context.req.param('id'), body), 201);
  });

  app.delete('/api/bookmarks/:id', (context) => {
    store.deleteBookmark(context.req.param('id'));
    return context.json({ ok: true });
  });

  app.post('/api/explorations/:id/note-groups', async (context) => {
    const body = newNoteGroupBody.parse(await context.req.json());
    return context.json(store.createNoteGroup(context.req.param('id'), body), 201);
  });

  app.patch('/api/note-groups/:id', async (context) => {
    const body = noteGroupChangesBody.parse(await context.req.json());
    return context.json(store.updateNoteGroup(context.req.param('id'), body));
  });

  app.delete('/api/note-groups/:id', (context) => {
    store.deleteNoteGroup(context.req.param('id'));
    return context.json({ ok: true });
  });

  app.post('/api/explorations/:id/notes', async (context) => {
    const body = newNoteBody.parse(await context.req.json());
    return context.json(store.createNote(context.req.param('id'), body), 201);
  });

  app.patch('/api/notes/:id', async (context) => {
    const body = noteChangesBody.parse(await context.req.json());
    return context.json(store.updateNote(context.req.param('id'), body, deviceOf(context)));
  });

  app.delete('/api/notes/:id', (context) => {
    store.deleteNote(context.req.param('id'));
    return context.json({ ok: true });
  });

  app.post('/api/note-groups/:id/reorder', async (context) => {
    const { afterGroupId } = noteGroupReorderBody.parse(await context.req.json());
    return context.json(store.reorderNoteGroup(context.req.param('id'), afterGroupId));
  });

  app.post('/api/note-groups/:id/rename-category', async (context) => {
    const { from, to } = categoryRenameBody.parse(await context.req.json());
    return context.json(
      store.renameNoteCategory(context.req.param('id'), from, to, deviceOf(context)),
    );
  });

  app.post('/api/notes/:id/reorder', async (context) => {
    const { afterNoteId } = noteReorderBody.parse(await context.req.json());
    return context.json(store.reorderNote(context.req.param('id'), afterNoteId));
  });

  app.put('/api/notes/:id/group', async (context) => {
    const { groupId } = noteGroupBody.parse(await context.req.json());
    return context.json(store.changeNoteGroup(context.req.param('id'), groupId));
  });

  app.post('/api/messages/:id/fork', async (context) => {
    const { forkId } = answerForkBody.parse(await context.req.json());
    return context.json(store.forkAtAnswer(context.req.param('id'), { forkId }), 201);
  });

  app.post('/api/messages/:id/split', async (context) => {
    const { forkId } = answerForkBody.parse(await context.req.json());
    return context.json(store.splitFork(context.req.param('id'), { forkId }), 201);
  });

  app.post('/api/notes/:id/fork', async (context) => {
    const { id, forkId, message } = noteForkBody.parse(await context.req.json());
    return context.json(store.forkFromNote(context.req.param('id'), message, { id, forkId }), 201);
  });

  app.post('/api/notes/:id/keep', (context) =>
    context.json(store.keepNote(context.req.param('id'))),
  );

  app.delete('/api/submissions/:id', (context) =>
    context.json(store.cancelSubmission(context.req.param('id'))),
  );

  // Which chat changed, for the chats list to reload while it is open.
  app.get('/api/events', (context) =>
    eventStream(context, (send) =>
      bus.subscribe((explorationId, event) =>
        send('exploration.changed', { explorationId, type: event.type }),
      ),
    ),
  );

  app.get('/api/explorations/:id/events', (context) => {
    const explorationId = context.req.param('id');
    if (!store.hasExploration(explorationId)) {
      throw new StoreError('not_found', `Exploration ${explorationId} does not exist.`);
    }
    // Each event carries the change log's number after it, so a page knows where it is.
    return eventStream(context, (send) =>
      bus.subscribeTo(explorationId, (event) =>
        send(event.type, { ...event, seq: store.latestChangeSeq() }),
      ),
    );
  });

  const internal = new Hono();

  internal.post('/explorations', async (context) => {
    const body = startExplorationBody.parse(await context.req.json());
    if (body.transcriptPath && !existsSync(body.transcriptPath)) {
      throw new StoreError('invalid', `Transcript ${body.transcriptPath} does not exist.`);
    }
    const transcriptPath = body.transcriptPath ?? findTranscript(body.sessionId);
    const transcript = transcriptPath ? readTranscript(transcriptPath) : null;
    const { exploration, mainFork } = store.createExploration({
      title: body.title ?? transcript?.title ?? '',
      messages: transcript?.messages ?? [],
      model: options.defaultModel,
    });
    store.attach({
      explorationId: exploration.id,
      shimId: body.shimId,
      sessionId: body.sessionId,
      takeover: false,
    });
    return context.json(
      {
        explorationId: exploration.id,
        mainForkId: mainFork.id,
        ...explorationUrls(exploration.id),
        importedMessages: transcript?.messages.length ?? 0,
        transcriptFound: transcript !== null,
      },
      201,
    );
  });

  internal.post('/explorations/:id/attach', async (context) => {
    const explorationId = context.req.param('id');
    const body = attachBody.parse(await context.req.json());
    store.attach({ explorationId, ...body });
    return context.json({
      ...explorationUrls(explorationId),
      forks: store.forkMap(explorationId),
    });
  });

  internal.post('/heartbeat', async (context) => {
    const { shimId } = shimBody.parse(await context.req.json());
    const explorationIds = store.heartbeat(shimId);
    options.runs.renewShimLeases(shimId);
    for (const explorationId of explorationIds) hub.refreshStatus(explorationId);
    return context.json({ explorationIds });
  });

  internal.post('/detach', async (context) => {
    const { shimId } = shimBody.parse(await context.req.json());
    options.runs.releaseShimFollowUps(shimId);
    for (const explorationId of store.detach(shimId)) hub.refreshStatus(explorationId);
    return context.json({ ok: true });
  });

  internal.get('/explorations/:id/map', (context) =>
    context.json({ forks: store.forkMap(context.req.param('id')) }),
  );

  internal.get('/forks/:id', (context) => {
    const limit = context.req.query('limit');
    const maxChars = context.req.query('maxChars');
    return context.json(
      store.readFork(
        context.req.param('id'),
        limit ? Number(limit) : undefined,
        maxChars ? Number(maxChars) : undefined,
      ),
    );
  });

  internal.post('/forks/:id/messages', async (context) => {
    const forkId = context.req.param('id');
    const body = addMessageBody.parse(await context.req.json());
    const message = store.addAssistantMessage({ forkId, ...body });
    options.runs.finishShimTurn(forkId, body.shimId, body.inReplyTo, message.id);
    hub.refreshStatus(store.forkExplorationId(forkId));
    return context.json({ messageId: message.id }, 201);
  });

  internal.patch('/forks/:id', async (context) => {
    const forkId = context.req.param('id');
    const { shimId, summary } = forkSummaryBody.parse(await context.req.json());
    store.requireAttachedShim(store.forkExplorationId(forkId), shimId);
    return context.json(store.updateForkSummary({ forkId, summary }));
  });

  // The session answering the main fork oversees the chat's other forks, which the runner answers.
  const supervisedForkId = (forkId: string, shimId: string) => {
    store.requireAttachedShim(store.forkExplorationId(forkId), shimId);
    return forkId;
  };

  internal.post('/forks/:id/stop', async (context) => {
    const { shimId } = shimBody.parse(await context.req.json());
    const forkId = supervisedForkId(context.req.param('id'), shimId);
    return context.json({ stopping: options.runs.requestStop(forkId) });
  });

  internal.post('/forks/:id/retry', async (context) => {
    const { shimId } = shimBody.parse(await context.req.json());
    options.runs.retry(supervisedForkId(context.req.param('id'), shimId));
    return context.json({ ok: true });
  });

  internal.post('/forks/:id/supervisor-messages', async (context) => {
    const { shimId, text } = supervisorMessageBody.parse(await context.req.json());
    const forkId = supervisedForkId(context.req.param('id'), shimId);
    const message = store.addSupervisorMessage(forkId, text);
    return context.json({ messageId: message.id }, 201);
  });

  internal.patch('/explorations/:id', async (context) => {
    const explorationId = context.req.param('id');
    const { shimId, ...changes } = explorationChangesBody.parse(await context.req.json());
    store.requireAttachedShim(explorationId, shimId);
    return context.json(store.updateExploration({ explorationId, ...changes }));
  });

  internal.post('/explorations/:id/feedback', async (context) => {
    const { shimId, waitMs } = feedbackBody.parse(await context.req.json());
    options.runs.releaseShimFollowUps(shimId);
    const result = await hub.waitForFeedback({
      explorationId: context.req.param('id'),
      shimId,
      waitMs,
      signal: context.req.raw.signal,
    });
    return context.json(result);
  });

  internal.get('/explorations/:id/board', (context) =>
    context.json(store.boardOverview(context.req.param('id'))),
  );

  internal.post('/explorations/:id/board', async (context) => {
    const explorationId = context.req.param('id');
    const { shimId, ...input } = arrangeBoardBody.parse(await context.req.json());
    store.requireAttachedShim(explorationId, shimId);
    return context.json(store.arrangeBoard(explorationId, input));
  });

  internal.get('/explorations/:id/notes', (context) =>
    context.json(store.listNotes(context.req.param('id'), context.req.query('groupId'))),
  );

  internal.get('/explorations/:id/notes/read', (context) =>
    context.json(
      store.readNotes(context.req.param('id'), (context.req.query('ids') ?? '').split(',')),
    ),
  );

  internal.get('/explorations/:id/notes/search', (context) =>
    context.json(store.searchNotes(context.req.param('id'), context.req.query('q') ?? '')),
  );

  internal.post('/explorations/:id/note-groups', async (context) => {
    const explorationId = context.req.param('id');
    const { shimId, ...group } = claudeNoteGroupBody.parse(await context.req.json());
    store.requireAttachedShim(explorationId, shimId);
    return context.json(store.createNoteGroup(explorationId, group), 201);
  });

  internal.post('/explorations/:id/notes', async (context) => {
    const explorationId = context.req.param('id');
    const { shimId, ...notes } = claudeNotesBody.parse(await context.req.json());
    store.requireAttachedShim(explorationId, shimId);
    return context.json(store.addNotes({ explorationId, ...notes }), 201);
  });

  // Claude changes a note only while its session is attached to the note's chat.
  const attachedNoteId = (noteId: string, shimId: string) => {
    store.requireAttachedShim(store.noteExplorationId(noteId), shimId);
    return noteId;
  };

  internal.patch('/notes/:id', async (context) => {
    const { shimId, ...changes } = claudeNoteChangesBody.parse(await context.req.json());
    return context.json(
      store.updateNote(attachedNoteId(context.req.param('id'), shimId), changes, 'claude'),
    );
  });

  internal.post('/note-groups/:id/rename-category', async (context) => {
    const { shimId, from, to } = claudeCategoryRenameBody.parse(await context.req.json());
    const groupId = context.req.param('id');
    store.requireAttachedShim(store.noteGroupExplorationId(groupId), shimId);
    return context.json(store.renameNoteCategory(groupId, from, to));
  });

  internal.post('/note-groups/:id/reorder', async (context) => {
    const { shimId, afterGroupId } = claudeNoteGroupReorderBody.parse(await context.req.json());
    const groupId = context.req.param('id');
    store.requireAttachedShim(store.noteGroupExplorationId(groupId), shimId);
    return context.json(store.reorderNoteGroup(groupId, afterGroupId));
  });

  internal.post('/notes/:id/reorder', async (context) => {
    const { shimId, afterNoteId } = claudeNoteReorderBody.parse(await context.req.json());
    const noteId = attachedNoteId(context.req.param('id'), shimId);
    return context.json(store.reorderNote(noteId, afterNoteId));
  });

  internal.put('/notes/:id/group', async (context) => {
    const { shimId, groupId } = claudeNoteGroupChangeBody.parse(await context.req.json());
    const noteId = attachedNoteId(context.req.param('id'), shimId);
    return context.json(store.changeNoteGroup(noteId, groupId));
  });

  internal.post('/notes/:id/deletion-request', async (context) => {
    const { shimId } = shimBody.parse(await context.req.json());
    return context.json(store.requestNoteDeletion(attachedNoteId(context.req.param('id'), shimId)));
  });

  // After each tool call of an attached session: what it did becomes steps in the forks it
  // answers, and messages the user sent meanwhile go back to it.
  internal.post('/sessions/:sessionId/steps', async (context) => {
    const sessionId = context.req.param('sessionId');
    const { texts, tool } = sessionStepBody.parse(await context.req.json());
    const exploration = store.explorationForSession(sessionId);
    const attachment = exploration ? store.attachment(exploration.id) : null;
    if (!exploration || !attachment?.live || attachment.sessionId !== sessionId) {
      return context.json({ explorationId: null, forks: [] });
    }
    const { working, arrived } = hub.duringWork(exploration.id, attachment.shimId);
    const followUps = options.runs.shimFollowUps(exploration.id, attachment.shimId);
    const steps = [
      ...texts.map((text) => ({ kind: 'text' as const, text })),
      ...(tool ? [{ kind: 'tool' as const, text: tool }] : []),
    ];
    for (const step of steps) {
      for (const fork of working) {
        options.runs.addShimActivity(fork.forkId, attachment.shimId, {
          afterMessageId: fork.inReplyTo,
          ...step,
        });
      }
      for (const forkId of followUps) options.runs.addShimActivity(forkId, attachment.shimId, step);
    }
    const shown = working.length > 0 || followUps.length > 0;
    const remind = shown && progressLines.count(attachment.shimId, texts.length > 0, tool !== null);
    return context.json({ explorationId: exploration.id, forks: arrived, remind });
  });

  internal.get('/sessions/:sessionId/exploration', (context) =>
    context.json({ exploration: store.explorationForSession(context.req.param('sessionId')) }),
  );

  app.route('/api/internal', internal);
  app.all('/api/*', (context) =>
    context.json({ error: 'not_found', message: 'Unknown route' }, 404),
  );
  app.get('*', serveUi(options.uiDirectory));

  // Old ids are prefixed before routing, which a middleware would be too late for.
  const withLegacyIds = new Hono();
  withLegacyIds.all('*', async (context) =>
    app.fetch(await withLegacyIdsPrefixed(context.req.raw), context.env),
  );
  return withLegacyIds;
}
