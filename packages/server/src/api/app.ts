import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { apiVersion } from '../config.js';
import { findTranscript, readTranscript } from '../import/transcript.js';
import type { BackgroundSessions } from '../sessions/background-sessions.js';
import { claudeModels, type ClaudeModel } from '../shared/models.js';
import type { ExplorationListItem, Snapshot } from '../shared/types.js';
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
  defaultModel: ClaudeModel;
  port: number;
  publicUrl: string | null;
  version: string;
  uiDirectory: string | null;
  onShutdown: () => void;
}

const sseKeepAliveMs = 20_000;
const maxFeedbackWaitMs = 280_000;

const commentType = z.enum(['inline', 'fork']);
const model = z.enum(claudeModels);
const newExplorationBody = z.object({ message: z.string().trim().min(1), model: model.optional() });
const explorationSettingsBody = z.object({ model });
const newCommentBody = z.object({
  messageId: z.string(),
  viewForkId: z.string(),
  quote: z.string(),
  startOffset: z.number().int(),
  endOffset: z.number().int(),
  body: z.string(),
  type: commentType.optional(),
});
const commentChangesBody = z.object({ body: z.string().optional(), type: commentType.optional() });
const forkBody = z.object({ forkId: z.string() });
const submitBody = z.object({ forkId: z.string(), globalMessage: z.string().default('') });
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
const feedbackBody = shimBody.extend({
  waitMs: z.number().int().positive().max(maxFeedbackWaitMs),
});

export function createApp(options: AppOptions) {
  const { store, hub, bus, sessions, port } = options;
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

  app.get('/api/settings', (context) => context.json({ defaultModel: options.defaultModel }));

  app.get('/api/explorations', (context) => {
    const explorations: ExplorationListItem[] = store
      .listExplorations()
      .map((exploration) => ({ ...exploration, sessionStatus: hub.status(exploration.id) }));
    return context.json(explorations);
  });

  app.post('/api/explorations', async (context) => {
    const body = newExplorationBody.parse(await context.req.json());
    const { exploration, mainFork } = store.createExploration({
      model: body.model ?? options.defaultModel,
    });
    store.submit(exploration.id, mainFork.id, body.message);
    return context.json({ explorationId: exploration.id }, 201);
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

  app.delete('/api/explorations/:id', (context) => {
    store.deleteExploration(context.req.param('id'));
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

  app.post('/api/explorations/:id/comments/fork-all', async (context) => {
    const { forkId } = forkBody.parse(await context.req.json());
    return context.json(store.toggleForkAll(context.req.param('id'), forkId));
  });

  app.post('/api/explorations/:id/submit', async (context) => {
    const { forkId, globalMessage } = submitBody.parse(await context.req.json());
    return context.json(store.submit(context.req.param('id'), forkId, globalMessage), 201);
  });

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
