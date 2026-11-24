import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const saved = { ...process.env };
afterEach(() => {
  for (const name of ['CHAT_EXPLORER_PORT', 'CHAT_EXPLORER_TOOLS_PORT']) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('the tools port', () => {
  it('is the main port + 1 unless set', () => {
    process.env.CHAT_EXPLORER_PORT = '4600';
    delete process.env.CHAT_EXPLORER_TOOLS_PORT;
    expect(loadConfig().toolsPort).toBe(4601);
    process.env.CHAT_EXPLORER_TOOLS_PORT = '5000';
    expect(loadConfig().toolsPort).toBe(5000);
  });

  it('refuses a value that is not a port number', () => {
    process.env.CHAT_EXPLORER_PORT = '4600';
    for (const value of ['abc', '0', '65536', '45.5', '-1', '4601x']) {
      process.env.CHAT_EXPLORER_TOOLS_PORT = value;
      expect(() => loadConfig(), value).toThrow(ConfigError);
      expect(() => loadConfig(), value).toThrow(/must be a port number from 1 to 65535/);
    }
  });

  it('refuses the main port', () => {
    process.env.CHAT_EXPLORER_PORT = '4600';
    process.env.CHAT_EXPLORER_TOOLS_PORT = '4600';
    expect(() => loadConfig()).toThrow(/the daemon's main port/);
  });
});
