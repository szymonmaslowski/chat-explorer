import { spawn } from 'node:child_process';

export function openBrowser(url: string) {
  const [command, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  spawn(command!, args, { detached: true, stdio: 'ignore' }).unref();
}
