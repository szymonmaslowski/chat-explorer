import { spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const runnerEntry = fileURLToPath(new URL('./main.js', import.meta.url));
const restartDelaysMs = [1_000, 5_000, 30_000];
// A runner that stayed up this long counts as healthy again, so its next crash restarts quickly.
const healthyAfterMs = 60_000;

// Keeps the runner process going next to the daemon: starts it, restarts it after a crash with a
// growing pause, and stops it with the daemon.
export function superviseRunner(options: { logPath: string; env: NodeJS.ProcessEnv }) {
  let child: ChildProcess | null = null;
  let stopped = false;
  let crashes = 0;

  const start = () => {
    const log = openSync(options.logPath, 'a');
    const startedAt = Date.now();
    child = spawn(process.execPath, [runnerEntry], {
      stdio: ['ignore', log, log],
      env: { ...process.env, ...options.env },
    });
    child.on('exit', () => {
      child = null;
      if (stopped) return;
      crashes = Date.now() - startedAt > healthyAfterMs ? 0 : crashes + 1;
      const delay = restartDelaysMs[Math.min(crashes, restartDelaysMs.length - 1)]!;
      setTimeout(() => !stopped && start(), delay).unref();
    });
  };

  start();
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        stopped = true;
        if (!child) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
