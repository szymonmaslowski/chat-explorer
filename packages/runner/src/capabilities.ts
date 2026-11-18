import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RunnerCapabilities } from '@chat-explorer/shared/types.js';
import type { HostRule } from './access-config.js';
import type { CodingMemory } from './memory-gate.js';
import type { RunnerConfig } from './runner-config.js';

const shownPatterns = (rules: HostRule[]) =>
  rules.filter((rule) => !rule.hidden).map((rule) => rule.pattern);

// The runner's ceilings as the backend may know them: names, hosts and limits, never a secret or a
// file path, and nothing marked hidden.
export function capabilitiesReport(
  config: RunnerConfig,
  sizing: CodingMemory,
  codingOff: string | null,
): RunnerCapabilities {
  const { coding } = config;
  let configHash = '';
  try {
    configHash = createHash('sha256').update(readFileSync(config.path)).digest('hex').slice(0, 16);
  } catch {
    configHash = 'none';
  }
  return {
    coding: coding.enabled && codingOff === null,
    codingOff: coding.enabled ? codingOff : `Coding is off in ${config.path}.`,
    allowedHosts: coding.allowedHosts && shownPatterns(coding.allowedHosts),
    privateHosts: shownPatterns(
      [
        ...(coding.allowedHosts ?? []),
        ...coding.credentials.flatMap((entry) => entry.hosts),
      ].filter((rule) => rule.private),
    ),
    credentials: coding.credentials
      .filter((credential) => !credential.hidden)
      .map((credential) => ({
        name: credential.name,
        type: credential.type,
        hosts: shownPatterns(credential.hosts),
      })),
    limits: {
      memory: sizing.memory,
      slots: sizing.slots,
      cpus: coding.cpus ?? null,
      processes: coding.processes,
      workspaceLimitGb: coding.workspaceLimitGb,
    },
    configHash,
  };
}
