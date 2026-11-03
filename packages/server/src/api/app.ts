import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { apiVersion } from '../config.js';
import { dictationHint, type Transcriber } from '../dictation/transcriber.js';
import type { FileStorage } from '../files/file-storage.js';
import { maxFileBytes } from '../files/kinds.js';
import { findTranscript, readTranscript } from '../import/transcript.js';
import type { BackgroundSessions } from '../sessions/background-sessions.js';
import type { Speaker } from '../speech/speaker.js';
import { idPattern } from '../shared/ids.js';
import { claudeModels, type ClaudeModel } from '../shared/models.js';
import type { ExplorationListItem, ExplorationView, Snapshot } from '../shared/types.js';
import { StoreError } from '../store/errors.js';
import type { EventBus } from '../store/event-bus.js';
import type { FeedbackHub } from '../store/feedback-hub.js';
import type { ChatStore } from '../store/store.js';
import { guardLocalRequests } from './guard.js';
import { serveUi } from './static-ui.js';

export interface AppOptions {
  store: ChatStore;
  hub: FeedbackHub;
  bus: EventBus;
  sessions: BackgroundSessions;
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
  .object({ message: z.string().trim().default(''), model: model.optional(), fileIds })
  .refine((body) => body.message || body.fileIds.length > 0, 'Write a message or attach a file.');
const explorationSettingsBody = z.object({ model });
const clientId = z.string().regex(idPattern).optional();
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
});
const commentChangesBody = z.object({
  body: z.string().optional(),
  editBody: z.string().nullable().optional(),
  type: commentType.optional(),
  noteGroupId: z.string().min(1).nullable().optional(),
});
const replyDraftBody = z.object({ text: z.string(), newFork: z.boolean(), fileIds });
const forkBody = z.object({ forkId: z.string() });
const submitBody = z.object({
  id: clientId,
  forkId: z.string(),
  globalMessage: z.string().default(''),
  newFork: z.boolean().default(false),
  fileIds,
});
const forkNowBody = z.object({ id: clientId });
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
});
const noteChangesBody = z.object({
  topic: z.string().optional(),
  description: z.string().optional(),
  checked: z.boolean().optional(),
});
const noteReorderBody = z.object({ afterNoteId: z.string().nullable() });
const noteGroupBody = z.object({ groupId: z.string() });
const uploadBody = z.object({ file: z.instanceof(File) });
// Multipart framing around a file at the size limit.
const uploadOverheadBytes = 64 * 1024;
const shimBody = z.object({ shimId: z.string() });
const startExplorationBody = shimBody.extend({
  sessionId: z.string(),
  transcriptPath: z.string().endsWith('.jsonl').optional(),
  title: z.string().optional(),
});
const attachBody = shimBody.extend({ sessionId: z.string(), takeover: z.boolean().default(false) });
const addMessageBody = shimBody.extend({ inReplyTo: z.string(), content: z.string().min(1) });
const forkSummaryBody = shimBody.extend({ summary: z.string() });
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
// A block of a message, or of text still being written, whose whole text picks the voice.
const speechBody = z.union([
  z.object({ messageId: z.string(), block: speechBlock }),
  z.object({ draft: z.string().max(maxSpeechTextLength), block: speechBlock }),
]);
const claudeNoteGroupBody = shimBody.extend({
  name: z.string().optional(),
  checklist: z.boolean().optional(),
});
const claudeNotesBody = shimBody.extend({
  groupId: z.string(),
  notes: z
    .array(z.object({ topic: z.string().optional(), description: z.string().optional() }))
    .min(1),
  sourceMessageId: z.string().optional(),
});
const claudeNoteChangesBody = shimBody.extend(noteChangesBody.shape);
const claudeNoteReorderBody = shimBody.extend(noteReorderBody.shape);
const claudeNoteGroupChangeBody = shimBody.extend(noteGroupBody.shape);
const feedbackBody = shimBody.extend({
  waitMs: z.number().int().positive().max(maxFeedbackWaitMs),
});

export function createApp(options: AppOptions) {
  const { store, hub, bus, sessions, transcriber, speaker, fileStorage, port } = options;
  const localUrl = `http://127.0.0.1:${port}`;
  const explorationUrls = (explorationId: string) => ({
    url: `${options.publicUrl ?? localUrl}/e/${explorationId}`,
    localUrl: `${localUrl}/e/${explorationId}`,
  });
  const app = new Hono();

  app.use('*', guardLocalRequests(port, options.publicUrl));

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
        : { messageId: null, content: body.draft }),
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
    const snapshot: Snapshot = {
      ...store.snapshot(explorationId),
      sessionStatus: hub.status(explorationId),
      sessionError: sessions.error(explorationId),
    };
    return context.json(snapshot);
  });

  app.patch('/api/explorations/:id', async (context) => {
    const explorationId = context.req.param('id');
    const { model } = explorationSettingsBody.parse(await context.req.json());
    const exploration = store.setModel(explorationId, model);
    sessions.restart(explorationId);
    return context.json(exploration);
  });

  app.post('/api/explorations/:id/session', (context) => {
    sessions.start(context.req.param('id'));
    return context.json({ ok: true }, 201);
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

  app.post('/api/comments/:id/fork-now', async (context) => {
    const { id } = forkNowBody.parse(await context.req.json());
    return context.json(store.forkNow(context.req.param('id'), { id }), 201);
  });

  app.post('/api/explorations/:id/comments/fork-all', async (context) => {
    const { forkId } = forkBody.parse(await context.req.json());
    return context.json(store.toggleForkAll(context.req.param('id'), forkId));
  });

  app.post('/api/explorations/:id/submit', async (context) => {
    const { id, forkId, globalMessage, newFork, fileIds } = submitBody.parse(
      await context.req.json(),
    );
    return context.json(
      store.submit(context.req.param('id'), forkId, globalMessage, { id, newFork, fileIds }),
      201,
    );
  });

  app.post('/api/forks/:id/archive', (context) =>
    context.json(store.archiveFork(context.req.param('id'))),
  );

  app.post('/api/forks/:id/unarchive', (context) =>
    context.json(store.unarchiveFork(context.req.param('id'))),
  );

  app.get('/api/forks/:id/reply-draft', (context) =>
    context.json(store.replyDraft(context.req.param('id'))),
  );

  app.put('/api/forks/:id/reply-draft', async (context) => {
    const draft = replyDraftBody.parse(await context.req.json());
    return context.json(store.saveReplyDraft(context.req.param('id'), draft));
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
    return context.json(store.updateNote(context.req.param('id'), body));
  });

  app.delete('/api/notes/:id', (context) => {
    store.deleteNote(context.req.param('id'));
    return context.json({ ok: true });
  });

  app.post('/api/notes/:id/reorder', async (context) => {
    const { afterNoteId } = noteReorderBody.parse(await context.req.json());
    return context.json(store.reorderNote(context.req.param('id'), afterNoteId));
  });

  app.put('/api/notes/:id/group', async (context) => {
    const { groupId } = noteGroupBody.parse(await context.req.json());
    return context.json(store.changeNoteGroup(context.req.param('id'), groupId));
  });

  app.post('/api/notes/:id/keep', (context) =>
    context.json(store.keepNote(context.req.param('id'))),
  );

  app.delete('/api/submissions/:id', (context) =>
    context.json(store.cancelSubmission(context.req.param('id'))),
  );

  app.get('/api/explorations/:id/events', (context) => {
    const explorationId = context.req.param('id');
    if (!store.hasExploration(explorationId)) {
      throw new StoreError('not_found', `Exploration ${explorationId} does not exist.`);
    }
    return streamSSE(context, async (stream) => {
      const unsubscribe = bus.subscribeTo(explorationId, (event) => {
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      });
      stream.onAbort(unsubscribe);
      await stream.writeSSE({ event: 'ready', data: '{}' });
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(sseKeepAliveMs);
        await stream.writeSSE({ event: 'ping', data: '' });
      }
      unsubscribe();
    });
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
    for (const explorationId of explorationIds) hub.refreshStatus(explorationId);
    return context.json({ explorationIds });
  });

  internal.post('/detach', async (context) => {
    const { shimId } = shimBody.parse(await context.req.json());
    for (const explorationId of store.detach(shimId)) hub.refreshStatus(explorationId);
    return context.json({ ok: true });
  });

  internal.get('/explorations/:id/map', (context) =>
    context.json({ forks: store.forkMap(context.req.param('id')) }),
  );

  internal.get('/forks/:id', (context) => {
    const limit = context.req.query('limit');
    return context.json(store.readFork(context.req.param('id'), limit ? Number(limit) : undefined));
  });

  internal.post('/forks/:id/messages', async (context) => {
    const body = addMessageBody.parse(await context.req.json());
    const message = store.addAssistantMessage({ forkId: context.req.param('id'), ...body });
    return context.json({ messageId: message.id }, 201);
  });

  internal.patch('/forks/:id', async (context) => {
    const body = forkSummaryBody.parse(await context.req.json());
    return context.json(store.updateForkSummary({ forkId: context.req.param('id'), ...body }));
  });

  internal.patch('/explorations/:id', async (context) => {
    const body = explorationChangesBody.parse(await context.req.json());
    return context.json(
      store.updateExploration({ explorationId: context.req.param('id'), ...body }),
    );
  });

  internal.post('/explorations/:id/feedback', async (context) => {
    const { shimId, waitMs } = feedbackBody.parse(await context.req.json());
    const result = await hub.waitForFeedback({
      explorationId: context.req.param('id'),
      shimId,
      waitMs,
      signal: context.req.raw.signal,
    });
    return context.json(result);
  });

  internal.get('/explorations/:id/notes', (context) =>
    context.json(store.readNotes(context.req.param('id'), context.req.query('groupId'))),
  );

  internal.post('/explorations/:id/note-groups', async (context) => {
    const explorationId = context.req.param('id');
    const { shimId, ...group } = claudeNoteGroupBody.parse(await context.req.json());
    store.requireAttachedShim(explorationId, shimId);
    return context.json(store.createNoteGroup(explorationId, group), 201);
  });

  internal.post('/explorations/:id/notes', async (context) => {
    const body = claudeNotesBody.parse(await context.req.json());
    return context.json(store.addNotes({ explorationId: context.req.param('id'), ...body }), 201);
  });

  // Claude changes a note only while its session is attached to the note's chat.
  const attachedNoteId = (noteId: string, shimId: string) => {
    store.requireAttachedShim(store.noteExplorationId(noteId), shimId);
    return noteId;
  };

  internal.patch('/notes/:id', async (context) => {
    const { shimId, ...changes } = claudeNoteChangesBody.parse(await context.req.json());
    return context.json(store.updateNote(attachedNoteId(context.req.param('id'), shimId), changes));
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

  internal.get('/sessions/:sessionId/exploration', (context) =>
    context.json({ exploration: store.explorationForSession(context.req.param('sessionId')) }),
  );

  app.route('/api/internal', internal);
  app.all('/api/*', (context) =>
    context.json({ error: 'not_found', message: 'Unknown route' }, 404),
  );
  app.get('*', serveUi(options.uiDirectory));

  return app;
}
