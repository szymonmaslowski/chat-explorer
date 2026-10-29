import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';

export interface SpeechWorkerOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  // Stopped after this long without work, which frees the memory the model holds.
  idleMs: number;
}

const answerSchema = z.union([
  z.object({ ready: z.literal(true) }),
  z.object({ id: z.string(), error: z.string().optional() }),
]);

const keptErrorLines = 20;

interface Running {
  child: ChildProcess;
  ready: Promise<void>;
  waiting: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
  errorLines: string[];
}

// The long-lived Python process that holds the speech model. It takes one request at a time;
// the caller waits for each answer before sending the next.
export class SpeechWorker {
  private running: Running | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 0;

  constructor(private readonly options: SpeechWorkerOptions) {}

  async render(text: string, language: string, output: string) {
    clearTimeout(this.idleTimer);
    try {
      const running = this.start();
      await running.ready;
      const id = String(this.nextId++);
      await new Promise<void>((resolve, reject) => {
        running.waiting.set(id, { resolve, reject });
        running.child.stdin?.write(`${JSON.stringify({ id, text, language, output })}\n`);
      });
    } finally {
      this.idleTimer = setTimeout(() => this.stop(), this.options.idleMs);
      this.idleTimer.unref();
    }
  }

  stop() {
    clearTimeout(this.idleTimer);
    this.running?.child.kill();
    this.running = null;
  }

  private start() {
    if (this.running) return this.running;
    const child = spawn(this.options.command, this.options.args, {
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let markReady = () => {};
    let failStart: (error: Error) => void = () => {};
    const running: Running = {
      child,
      ready: new Promise<void>((resolve, reject) => {
        markReady = resolve;
        failStart = reject;
      }),
      waiting: new Map(),
      errorLines: [],
    };
    running.ready.catch(() => {});
    createInterface({ input: child.stderr! }).on('line', (line) => {
      running.errorLines.push(line);
      running.errorLines.splice(0, running.errorLines.length - keptErrorLines);
    });
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const parsed = answerSchema.safeParse(safeJson(line));
      if (!parsed.success) return;
      const answer = parsed.data;
      if ('ready' in answer) return markReady();
      const waiter = running.waiting.get(answer.id);
      running.waiting.delete(answer.id);
      if (answer.error) waiter?.reject(new Error(answer.error));
      else waiter?.resolve();
    });
    const fail = (error: Error) => {
      if (this.running === running) this.running = null;
      failStart(error);
      for (const waiter of running.waiting.values()) waiter.reject(error);
      running.waiting.clear();
    };
    child.on('error', fail);
    child.on('exit', (code, signal) => {
      const details = running.errorLines.slice(-5).join('\n');
      fail(
        new Error(
          `The speech worker stopped (${signal ?? `exit code ${code}`}).${details ? `\n${details}` : ''}`,
        ),
      );
    });
    this.running = running;
    return running;
  }
}

function safeJson(line: string) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
