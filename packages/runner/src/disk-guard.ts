import { mkdirSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import type { EngineRunSpec } from './engine.js';
import { workspaceSize } from './workspace-size.js';

const gigabyte = 1024 ** 3;
// Past this share of its limit, a workspace stops the run instead of only warning.
const hardLimitFactor = 1.5;

export interface DiskLimits {
  workspaceLimitGb: number;
  minFreeGb: number;
}

// Docker can't cap a bind mount, so a coding fork's disk use is measured instead: its workspace
// against a soft limit, the Mac's free space, and the free space of the disk containers write to.
export interface DiskGuard {
  // Why a coding run must not start now, or null.
  refusal(spec: EngineRunSpec): Promise<string | null>;
  // Measured while a coding run works: a warning to show, or a reason to stop it.
  check(spec: EngineRunSpec): Promise<{ warning?: string; stop?: string }>;
}

const shown = (bytes: number) => `${(bytes / gigabyte).toFixed(1)} GB`;

export function diskGuard(options: {
  limits: DiskLimits;
  workspacesPath: string;
  workspaceOf: (spec: EngineRunSpec) => string;
  // Free bytes on the disk containers write to, seen from the fork's running container.
  containerFreeBytes: (spec: EngineRunSpec) => Promise<number | null>;
}): DiskGuard {
  const limit = options.limits.workspaceLimitGb * gigabyte;
  const minFree = options.limits.minFreeGb * gigabyte;

  async function hostFreeBytes() {
    mkdirSync(options.workspacesPath, { recursive: true });
    const stats = await statfs(options.workspacesPath);
    return stats.bavail * stats.bsize;
  }

  const lowOnMac = (free: number) =>
    `Your Mac has ${shown(free)} free, below the ${options.limits.minFreeGb} GB this runner keeps free, so coding runs are stopped. Free some space and send the message again.`;
  const tooBig = (size: number) =>
    `This fork's workspace is ${shown(size)}, past 1.5 times its ${options.limits.workspaceLimitGb} GB limit, so the run was stopped. Delete files from the workspace, or raise coding.workspaceLimitGb in the runner's config.`;

  async function overLimit(spec: EngineRunSpec) {
    const size = await workspaceSize(options.workspaceOf(spec)).catch(() => 0);
    return { size, hard: size > limit * hardLimitFactor, soft: size > limit };
  }

  return {
    async refusal(spec) {
      const free = await hostFreeBytes();
      if (free < minFree) return lowOnMac(free);
      const { size, hard } = await overLimit(spec);
      return hard ? tooBig(size) : null;
    },
    async check(spec) {
      const free = await hostFreeBytes();
      if (free < minFree) return { stop: lowOnMac(free) };
      const containerFree = await options.containerFreeBytes(spec);
      if (containerFree !== null && containerFree < minFree) {
        return {
          stop: `Docker's disk has ${shown(containerFree)} free, below the ${options.limits.minFreeGb} GB this runner keeps free, so the run was stopped. Free space in Docker Desktop (unused images and build cache) and send the message again.`,
        };
      }
      const { size, hard, soft } = await overLimit(spec);
      if (hard) return { stop: tooBig(size) };
      if (soft) {
        return {
          warning: `This fork's workspace is ${shown(size)}, over its ${options.limits.workspaceLimitGb} GB limit. At 1.5 times the limit the run stops.`,
        };
      }
      return {};
    },
  };
}
