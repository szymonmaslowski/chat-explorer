import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface CommandResult {
  code: number | null;
  output: string;
}

export interface CommandOptions {
  stdin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

// Everything the runner asks of a container runtime. Only Docker Desktop has been used so far: a
// second runtime is a second implementation of this, tested on its own, not a redesign.
export interface ContainerRuntime {
  // A command run to completion: building images, the network, the egress proxy.
  command(args: string[], options?: CommandOptions): Promise<CommandResult>;
  // A container attached to this process, for one engine run.
  start(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams;
  kill(name: string): void;
  // Free bytes on the disk containers write to, seen from inside a running one. With Docker
  // Desktop that is its VM's disk, apart from the Mac's own.
  freeBytes(container: string): Promise<number | null>;
  // Which runtime answers, and whether coding forks have been tested on it.
  identify(): Promise<{ name: string; supported: boolean }>;
}

const dockerCommand = (args: string[], { stdin, timeoutMs, env }: CommandOptions = {}) =>
  new Promise<CommandResult>((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let output = '';
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            output += `\nStopped after ${timeoutMs / 60_000} minutes.`;
            child.kill('SIGKILL');
          }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (error) => resolve({ code: null, output: error.message }));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.stdin.end(stdin);
  });

export const dockerRuntime: ContainerRuntime = {
  command: dockerCommand,
  start: (args, env) => spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env }),
  kill: (name) => {
    spawn('docker', ['kill', name], { stdio: 'ignore' });
  },
  async freeBytes(container) {
    const result = await dockerCommand(['exec', container, 'df', '-Pk', '/'], {
      timeoutMs: 30_000,
    });
    const available = Number(result.output.trim().split('\n').at(-1)?.split(/\s+/)[3]);
    return result.code === 0 && Number.isFinite(available) ? available * 1024 : null;
  },
  async identify() {
    const result = await dockerCommand(['info', '--format', '{{.OperatingSystem}}']);
    const name = result.code === 0 ? result.output.trim() : 'no Docker engine';
    return { name, supported: name.includes('Docker Desktop') };
  },
};

// The one place the runtime is chosen.
export const runtime: ContainerRuntime = dockerRuntime;
