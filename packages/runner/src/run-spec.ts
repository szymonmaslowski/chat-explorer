import { prefixedIdPattern } from '@chat-explorer/shared/ids.js';
import { claudeModels } from '@chat-explorer/shared/models.js';
import type { Lease, RunContext } from '@chat-explorer/shared/protocol.js';
import type { EngineRunSpec } from './engine.js';
import type { RunnerConfig } from './runner-config.js';

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A job the runner will not run, with the reason to show in the fork.
export class RunRefusedError extends Error {}

// The engine's spec, built only from the fields the runner knows and checked against its own
// config. Ids end up in folder paths and container names, so a backend that sends anything else,
// even by mistake, gets a refusal instead of a path outside the runner's folders.
export function checkedRunSpec(input: {
  lease: Lease;
  context: RunContext;
  sessionId: string;
  toolsUrl: string;
  config: RunnerConfig;
}): EngineRunSpec {
  const { lease, context, sessionId, config } = input;
  if (!prefixedIdPattern.test(lease.forkId)) throw new RunRefusedError('The fork id is not valid.');
  if (!prefixedIdPattern.test(lease.explorationId)) {
    throw new RunRefusedError('The chat id is not valid.');
  }
  if (!sessionIdPattern.test(sessionId)) throw new RunRefusedError('The session id is not valid.');
  if (!claudeModels.includes(context.model)) {
    throw new RunRefusedError(`This runner does not know the model ${context.model}.`);
  }
  if (context.coding !== true && context.coding !== false) {
    throw new RunRefusedError('The coding switch is not valid.');
  }
  if (context.coding && !config.coding.enabled) {
    throw new RunRefusedError(
      `Coding is turned on for this fork, but this runner does not allow it. To allow it, set "coding": { "enabled": true } in ${config.path} and restart the daemon.`,
    );
  }
  return {
    forkId: lease.forkId,
    explorationId: lease.explorationId,
    model: context.model,
    sessionId,
    resume: lease.sessionId !== null,
    coding: context.coding,
    systemPrompt: context.systemPrompt,
    toolsUrl: input.toolsUrl,
    toolsToken: lease.toolsToken,
  };
}
