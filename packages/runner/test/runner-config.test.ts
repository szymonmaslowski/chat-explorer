import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunnerConfig, RunnerConfigError } from '../src/runner-config.js';

const runnerPath = mkdtempSync(join(tmpdir(), 'runner-config-'));
const configPath = join(runnerPath, 'config.json');

afterEach(() => rmSync(configPath, { force: true }));

describe("the runner's own config", () => {
  it('turns coding off when there is no config file', () => {
    expect(readRunnerConfig(runnerPath)).toEqual({
      path: configPath,
      coding: {
        enabled: false,
        memory: '4g',
        processes: 512,
        workspaceLimitGb: 10,
        minFreeGb: 10,
      },
    });
  });

  it('allows coding only when the file says so', () => {
    writeFileSync(configPath, JSON.stringify({ coding: { enabled: true } }));
    expect(readRunnerConfig(runnerPath).coding.enabled).toBe(true);
    writeFileSync(configPath, JSON.stringify({}));
    expect(readRunnerConfig(runnerPath).coding.enabled).toBe(false);
  });

  it("takes a coding container's memory and process limits from the file", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ coding: { enabled: true, memory: '8g', processes: 2048, cpus: 6 } }),
    );
    expect(readRunnerConfig(runnerPath).coding).toMatchObject({
      enabled: true,
      memory: '8g',
      processes: 2048,
      cpus: 6,
    });
  });

  it('lets a coding container use every CPU unless the file caps them', () => {
    writeFileSync(configPath, JSON.stringify({ coding: { enabled: true } }));
    expect(readRunnerConfig(runnerPath).coding).not.toHaveProperty('cpus');
  });

  it('takes the disk limits from the file, as gigabytes above 0', () => {
    writeFileSync(configPath, JSON.stringify({ coding: { workspaceLimitGb: 25, minFreeGb: 5.5 } }));
    expect(readRunnerConfig(runnerPath).coding).toMatchObject({
      workspaceLimitGb: 25,
      minFreeGb: 5.5,
    });
    for (const workspaceLimitGb of [0, -1, '10', null]) {
      writeFileSync(configPath, JSON.stringify({ coding: { workspaceLimitGb } }));
      if (workspaceLimitGb === null) {
        expect(readRunnerConfig(runnerPath).coding.workspaceLimitGb).toBe(10);
        continue;
      }
      expect(() => readRunnerConfig(runnerPath)).toThrow(
        `coding.workspaceLimitGb in ${configPath}`,
      );
    }
  });

  it('refuses limits Docker would not read as meant', () => {
    for (const memory of ['4', '4gb', '0g', 4, '-1g', '4g --privileged']) {
      writeFileSync(configPath, JSON.stringify({ coding: { memory } }));
      expect(() => readRunnerConfig(runnerPath)).toThrow(`coding.memory in ${configPath}`);
    }
    for (const cpus of [0, -1, '4', null]) {
      writeFileSync(configPath, JSON.stringify({ coding: { cpus } }));
      expect(() => readRunnerConfig(runnerPath)).toThrow(`coding.cpus in ${configPath}`);
    }
    for (const processes of [0, -5, 1.5, '512']) {
      writeFileSync(configPath, JSON.stringify({ coding: { processes } }));
      expect(() => readRunnerConfig(runnerPath)).toThrow(`coding.processes in ${configPath}`);
    }
  });

  it('refuses a file it cannot read safely, naming it', () => {
    writeFileSync(configPath, '{ coding: true');
    expect(() => readRunnerConfig(runnerPath)).toThrow(RunnerConfigError);
    writeFileSync(configPath, JSON.stringify({ coding: { enabled: 'yes' } }));
    expect(() => readRunnerConfig(runnerPath)).toThrow(`coding.enabled in ${configPath}`);
  });
});
