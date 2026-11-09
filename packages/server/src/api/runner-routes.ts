import { timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { EventBus } from '../store/event-bus.js';
import { buildRunContext } from '../store/run-context.js';
import type { RunStore } from '../store/runs.js';
import type { ChatStore } from '../store/store.js';
import { waitUntil } from '../store/wait-until.js';

export interface RunnerRoutesOptions {
  store: ChatStore;
  runs: RunStore;
  bus: EventBus;
  machineToken: string;
}

const maxWaitMs = 60_000;
const waitBody = z.object({ waitMs: z.number().int().min(0).max(maxWaitMs).default(0) });
const claimBody = waitBody.extend({ runnerId: z.string().min(1) });
const leaseBody = z.object({ leaseId: z.string() });
const contextBody = leaseBody.extend({ resume: z.boolean() });
const inputBody = leaseBody.extend({ ...waitBody.shape, after: z.string().optional() });
const finishBody = leaseBody.extend({ upToMessageId: z.string() });
const answerBody = leaseBody.extend({ content: z.string().min(1) });
const activityBody = leaseBody.extend({
  afterMessageId: z.string(),
  kind: z.enum(['tool', 'text', 'progress']),
  text: z.string().min(1),
});
const sessionBody = leaseBody.extend({ sessionId: z.string().min(1) });
const usageBody = leaseBody.extend({
  model: z.string().min(1),
  contextTokens: z.number().int().min(0),
  contextWindow: z.number().int().positive().nullable(),
});
const waitingBody = leaseBody.extend({ until: z.string() });
const failBody = leaseBody.extend({ reason: z.string() });

const sameSecret = (given: string, expected: string) => {
  const givenBytes = Buffer.from(given);
  const expectedBytes = Buffer.from(expected);
  return givenBytes.length === expectedBytes.length && timingSafeEqual(givenBytes, expectedBytes);
};

// What a runner calls: claim a fork that needs an answer, hold it with heartbeats, take its new
// messages, report back, and let it go. Every call carries the machine token.
export function registerRunnerRoutes(app: Hono, options: RunnerRoutesOptions) {
  const { store, runs, bus, machineToken } = options;

  app.use(
    '/api/runner/*',
    createMiddleware(async (context, next) => {
      const token = context.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
      if (!sameSecret(token, machineToken)) {
        return context.json({ error: 'unauthorized', message: 'Wrong runner token.' }, 401);
      }
      await next();
    }),
  );

  app.post('/api/runner/claim', async (context) => {
    const { runnerId, waitMs } = claimBody.parse(await context.req.json());
    const lease = await waitUntil(
      bus,
      () => {
        for (const { forkId } of runs.claimable()) {
          const claimed = runs.claim(forkId, runnerId);
          if (claimed) return claimed;
        }
        return null;
      },
      waitMs,
      context.req.raw.signal,
    );
    return context.json({ lease });
  });

  app.post('/api/runner/forks/:forkId/heartbeat', async (context) => {
    const { leaseId } = leaseBody.parse(await context.req.json());
    runs.heartbeat(context.req.param('forkId'), leaseId);
    return context.json({ ok: true });
  });

  app.post('/api/runner/forks/:forkId/input', async (context) => {
    const forkId = context.req.param('forkId');
    const { leaseId, waitMs, after } = inputBody.parse(await context.req.json());
    const messages = await waitUntil(
      bus,
      () => {
        const pending = runs.pendingInput(forkId, leaseId, after);
        return pending.length > 0 ? pending : null;
      },
      waitMs,
      context.req.raw.signal,
    );
    if (!messages) return context.json({ messages: [], others: null });
    return context.json({ messages, others: runs.othersUpdate(forkId, leaseId) });
  });

  app.post('/api/runner/forks/:forkId/context', async (context) => {
    const forkId = context.req.param('forkId');
    const { leaseId, resume } = contextBody.parse(await context.req.json());
    const pendingIds = new Set(runs.pendingInput(forkId, leaseId).map((message) => message.id));
    const runContext = buildRunContext(store, forkId, { resume, pendingIds });
    // A new session's digest covers the other forks so far; a resumed one hears from now on.
    if (!resume) runs.markOthersSeen(forkId, leaseId);
    return context.json(runContext);
  });

  app.post('/api/runner/forks/:forkId/turn/start', async (context) => {
    const { leaseId } = leaseBody.parse(await context.req.json());
    runs.startTurn(context.req.param('forkId'), leaseId);
    return context.json({ ok: true });
  });

  app.post('/api/runner/forks/:forkId/turn/finish', async (context) => {
    const { leaseId, upToMessageId } = finishBody.parse(await context.req.json());
    runs.finishTurn(context.req.param('forkId'), leaseId, upToMessageId);
    return context.json({ ok: true });
  });

  app.post('/api/runner/forks/:forkId/answer', async (context) => {
    const { leaseId, content } = answerBody.parse(await context.req.json());
    return context.json(runs.answer(context.req.param('forkId'), leaseId, content), 201);
  });

  app.post('/api/runner/forks/:forkId/activity', async (context) => {
    const { leaseId, ...activity } = activityBody.parse(await context.req.json());
    return context.json(runs.addActivity(context.req.param('forkId'), leaseId, activity), 201);
  });

  app.post('/api/runner/forks/:forkId/session', async (context) => {
    const { leaseId, sessionId } = sessionBody.parse(await context.req.json());
    runs.recordSession(context.req.param('forkId'), leaseId, sessionId);
    return context.json({ ok: true });
  });

  app.post('/api/runner/forks/:forkId/usage', async (context) => {
    const { leaseId, ...usage } = usageBody.parse(await context.req.json());
    runs.recordUsage(context.req.param('forkId'), leaseId, usage);
    return context.json({ ok: true });
  });

  app.post('/api/runner/forks/:forkId/waiting', async (context) => {
    const { leaseId, until } = waitingBody.parse(await context.req.json());
    runs.waitForUsageLimit(context.req.param('forkId'), leaseId, until);
    return context.json({ ok: true });
  });

  app.post('/api/runner/forks/:forkId/release', async (context) => {
    const { leaseId } = leaseBody.parse(await context.req.json());
    runs.release(context.req.param('forkId'), leaseId);
    return context.json({ ok: true });
  });

  app.post('/api/runner/forks/:forkId/fail', async (context) => {
    const { leaseId, reason } = failBody.parse(await context.req.json());
    runs.fail(context.req.param('forkId'), leaseId, reason);
    return context.json({ ok: true });
  });
}
