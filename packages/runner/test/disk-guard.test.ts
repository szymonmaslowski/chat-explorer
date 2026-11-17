import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { diskGuard } from '../src/disk-guard.js';
import type { EngineRunSpec } from '../src/engine.js';

const root = mkdtempSync(join(tmpdir(), 'disk-guard-'));
const workspace = join(root, 'workspace');
mkdirSync(workspace);
const spec = { forkId: 'fork_0000000001' } as EngineRunSpec;
const megabytes = (count: number) => count / 1024;

afterAll(() => rmSync(root, { recursive: true, force: true }));

const guard = (options: { workspaceLimitGb: number; minFreeGb?: number; containerFree?: number }) =>
  diskGuard({
    limits: { workspaceLimitGb: options.workspaceLimitGb, minFreeGb: options.minFreeGb ?? 0.001 },
    workspacesPath: root,
    workspaceOf: () => workspace,
    containerFreeBytes: async () => options.containerFree ?? null,
  });

describe("a coding fork's disk guard", () => {
  writeFileSync(join(workspace, 'two-megabytes.bin'), Buffer.alloc(2 * 1024 * 1024));

  it('lets a workspace under its limit run, with no warning', async () => {
    const underLimit = guard({ workspaceLimitGb: megabytes(4) });
    expect(await underLimit.refusal(spec)).toBeNull();
    expect(await underLimit.check(spec)).toEqual({});
  });

  it('warns over the limit, and stops a run past 1.5 times it', async () => {
    expect((await guard({ workspaceLimitGb: megabytes(1.5) }).check(spec)).warning).toMatch(
      /over its .* GB limit/,
    );
    const pastLimit = guard({ workspaceLimitGb: megabytes(1) });
    expect((await pastLimit.check(spec)).stop).toMatch(/past 1\.5 times its .* GB limit/);
    expect(await pastLimit.refusal(spec)).toMatch(/past 1\.5 times/);
  });

  it("stops coding runs when the Mac or Docker's disk is low on space", async () => {
    const lowMac = guard({ workspaceLimitGb: 10, minFreeGb: 1_000_000 });
    expect(await lowMac.refusal(spec)).toMatch(/^Your Mac has .* free, below the 1000000 GB/);
    expect((await lowMac.check(spec)).stop).toMatch(/^Your Mac has/);
    const lowDocker = guard({ workspaceLimitGb: 10, minFreeGb: 1, containerFree: 1024 });
    expect((await lowDocker.check(spec)).stop).toMatch(/^Docker's disk has 0\.0 GB free/);
  });
});
