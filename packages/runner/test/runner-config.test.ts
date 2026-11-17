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
    expect(readRunnerConfig(runnerPath)).toEqual({ path: configPath, coding: { enabled: false } });
  });

  it('allows coding only when the file says so', () => {
    writeFileSync(configPath, JSON.stringify({ coding: { enabled: true } }));
    expect(readRunnerConfig(runnerPath).coding.enabled).toBe(true);
    writeFileSync(configPath, JSON.stringify({}));
    expect(readRunnerConfig(runnerPath).coding.enabled).toBe(false);
  });

  it('refuses a file it cannot read safely, naming it', () => {
    writeFileSync(configPath, '{ coding: true');
    expect(() => readRunnerConfig(runnerPath)).toThrow(RunnerConfigError);
    writeFileSync(configPath, JSON.stringify({ coding: { enabled: 'yes' } }));
    expect(() => readRunnerConfig(runnerPath)).toThrow(`coding.enabled in ${configPath}`);
  });
});
