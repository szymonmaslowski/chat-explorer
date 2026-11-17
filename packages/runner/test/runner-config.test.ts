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
      coding: { enabled: false, memory: '4g', processes: 512 },
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
      JSON.stringify({ coding: { enabled: true, memory: '8g', processes: 2048 } }),
    );
    expect(readRunnerConfig(runnerPath).coding).toEqual({
      enabled: true,
      memory: '8g',
      processes: 2048,
    });
  });

  it('refuses limits Docker would not read as meant', () => {
    for (const memory of ['4', '4gb', '0g', 4, '-1g', '4g --privileged']) {
      writeFileSync(configPath, JSON.stringify({ coding: { memory } }));
      expect(() => readRunnerConfig(runnerPath)).toThrow(`coding.memory in ${configPath}`);
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
