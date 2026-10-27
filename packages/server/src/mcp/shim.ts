import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createDaemonClient, DaemonError } from '../client/http.js';
import { apiVersion, loadConfig, type Config } from '../config.js';
import { DaemonStartError, ensureDaemon } from '../daemon/control.js';
import { openBrowser } from '../open-browser.js';
import type { ExplorationListItem } from '../shared/types.js';
import type { FeedbackResult } from '../store/feedback-hub.js';
import type { ForkMapEntry, ForkRead } from '../store/store.js';
import { packageVersion } from '../version.js';

const heartbeatIntervalMs = 15_000;
// Node's fetch gives up waiting for response headers after 300 s, so long-polls stay below that.
const feedbackRoundMs = 240_000;
// The plugin gives this server a 24 h tool timeout; returning earlier avoids a hard failure.
const defaultFeedbackTimeoutSeconds = 23 * 60 * 60;

export interface ShimOptions {
  config: Config;
  version: string;
  openUrl: (url: string) => void;
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
    daemonReady ??= ensureDaemon(options.config, { version: options.version, apiVersion });
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
        title: z.string().optional().describe('A short title for the exploration'),
      },
    },
    tool(async ({ sessionId, title }: { sessionId: string; title?: string | undefined }) => {
      const started = await request<{ explorationId: string; mainForkId: string; url: string }>(
        '/api/internal/explorations',
        { json: { shimId, sessionId, title } },
      );
      attachment = { explorationId: started.explorationId, sessionId };
      options.openUrl(started.url);
      return json(started);
    }),
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
        const attached = await request<{ url: string; forks: ForkMapEntry[] }>(
          `/api/internal/explorations/${explorationId}/attach`,
          { json: { shimId, sessionId, takeover: takeover ?? false } },
        );
        attachment = { explorationId, sessionId };
        options.openUrl(attached.url);
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
        'Get the fork tree of an exploration: each fork with its parent, summary, message count and whether it awaits an answer. No message bodies.',
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
      },
    },
    tool(async ({ forkId, limit }: { forkId: string; limit?: number | undefined }) => {
      const query = limit ? `?limit=${limit}` : '';
      return json(await request<ForkRead>(`/api/internal/forks/${forkId}${query}`));
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
    'await_feedback',
    {
      description:
        'Wait for the user to submit comments or messages in the browser. Returns every fork awaiting an answer, with its unanswered user messages. On "timeout" call it again; on "detached" or "deleted" stop.',
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
        if (result.status !== 'timeout' || Date.now() >= deadline || signal.aborted) {
          return json(result);
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

export async function runShim() {
  const shim = createShim({ config: loadConfig(), version: packageVersion, openUrl: openBrowser });
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void shim.close().finally(() => process.exit(0));
  };
  process.stdin.on('end', () => transport.onclose?.());
  await shim.server.connect(transport);
}
