import { prefixedIdPattern } from '@chat-explorer/shared/ids.js';
import { claudeModels } from '@chat-explorer/shared/models.js';
import {
  isHostPort,
  maxAllowedHosts,
  maxCredentials,
  networkHosts,
  registryNames,
  type ForkNetwork,
} from '@chat-explorer/shared/network.js';
import type { Lease, RunContext } from '@chat-explorer/shared/protocol.js';
import { matchesRule } from './access-config.js';
import { noHosts, type EngineRunSpec, type HostPolicy } from './engine.js';
import type { RunnerConfig } from './runner-config.js';

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A job the runner will not run, with the reason to show in the fork.
export class RunRefusedError extends Error {}

function refuse(reason: string): never {
  throw new RunRefusedError(reason);
}

// What a coding fork's container may reach and with which credentials, from the fork's settings
// checked against the runner's config. Entries go into the proxy's policy, so anything but a plain
// host:port is refused, and so is a host or credential the runner's config doesn't offer.
export function checkedAccess(network: ForkNetwork, config: RunnerConfig) {
  const { hosts, registries, credentials: names } = network ?? {};
  const knownRegistries =
    Array.isArray(registries) && registries.every((name) => registryNames.includes(name));
  const validNames =
    Array.isArray(names) &&
    names.length <= maxCredentials &&
    names.every((name) => typeof name === 'string');
  if (!knownRegistries || !validNames || !Array.isArray(hosts) || hosts.length > maxAllowedHosts) {
    refuse("The fork's allowed hosts are not valid.");
  }
  const invalid = hosts.find((host) => typeof host !== 'string' || !isHostPort(host));
  if (invalid !== undefined) {
    refuse(`The allowed host ${JSON.stringify(invalid)} is not a host:port.`);
  }
  const { allowedHosts: ceiling, credentials: offered } = config.coding;
  const credentials = names.map(
    (name) =>
      offered.find((credential) => credential.name === name) ??
      refuse(
        `The credential "${name}" is not in this runner's config. Add it under coding.credentials in ${config.path} and restart the daemon.`,
      ),
  );
  const requested = networkHosts({ hosts, registries });
  const ceilingRules = (hostPort: string) =>
    ceiling?.filter((rule) => matchesRule(rule, hostPort)) ?? [];
  const outside = ceiling && requested.find((hostPort) => ceilingRules(hostPort).length === 0);
  if (outside) {
    refuse(
      `This runner doesn't allow ${outside}. To allow it, add it to coding.allowedHosts in ${config.path} and restart the daemon.`,
    );
  }
  const credentialRules = credentials.flatMap((credential) => credential.hosts);
  const allHosts = [...new Set([...requested, ...credentialRules.map((rule) => rule.pattern)])];
  const rulesOf = (hostPort: string) => [
    ...ceilingRules(hostPort),
    ...credentialRules.filter((rule) => rule.pattern === hostPort),
  ];
  const everyRule = [...(ceiling ?? []), ...offered.flatMap((credential) => credential.hosts)];
  const policy: HostPolicy = {
    hosts: allHosts,
    privateHosts: allHosts.filter((hostPort) => rulesOf(hostPort).some((rule) => rule.private)),
    hiddenHosts: [...new Set(everyRule.filter((rule) => rule.hidden).map((rule) => rule.pattern))],
  };
  return { network: policy, credentials };
}

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
    ...(context.coding
      ? checkedAccess(context.network, config)
      : { network: noHosts, credentials: [] }),
    systemPrompt: context.systemPrompt,
    toolsUrl: input.toolsUrl,
    toolsToken: lease.toolsToken,
  };
}
