import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SpeechWorker } from '../src/speech/speech-worker.js';

// Stands in for speech_worker.py: same protocol, writes the text instead of audio.
const fakeWorker = `
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(process.env.STARTS, 'start\\n');
console.error('loading the model');
console.log(JSON.stringify({ ready: true }));
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.text === 'crash') {
    console.error('the model ran out of memory');
    process.exit(3);
  }
  if (request.text === 'fail') {
    console.log(JSON.stringify({ id: request.id, error: 'cannot say that' }));
    continue;
  }
  writeFileSync(request.output, request.language + ':' + request.text);
  console.log(JSON.stringify({ id: request.id }));
}
`;

const workers: SpeechWorker[] = [];

function setup(idleMs = 60_000) {
  const directory = mkdtempSync(join(tmpdir(), 'chat-explorer-speech-worker-'));
  const script = join(directory, 'worker.mjs');
  const starts = join(directory, 'starts');
  writeFileSync(script, fakeWorker);
  writeFileSync(starts, '');
  const worker = new SpeechWorker({
    command: process.execPath,
    args: [script],
    env: { ...process.env, STARTS: starts },
    idleMs,
  });
  workers.push(worker);
  const output = (name: string) => join(directory, name);
  const startCount = () => readFileSync(starts, 'utf8').split('\n').filter(Boolean).length;
  return { worker, output, startCount };
}

afterEach(() => {
  for (const worker of workers.splice(0)) worker.stop();
});

describe('speech worker', () => {
  it('starts once and renders requests one after another', async () => {
    const { worker, output, startCount } = setup();
    await worker.render('Cześć.', 'pl', output('a'));
    await worker.render('Hello.', 'en', output('b'));
    expect(readFileSync(output('a'), 'utf8')).toBe('pl:Cześć.');
    expect(readFileSync(output('b'), 'utf8')).toBe('en:Hello.');
    expect(startCount()).toBe(1);
  });

  it('reports a failed render and keeps going', async () => {
    const { worker, output } = setup();
    await expect(worker.render('fail', 'en', output('a'))).rejects.toThrow('cannot say that');
    await worker.render('Hello.', 'en', output('b'));
    expect(readFileSync(output('b'), 'utf8')).toBe('en:Hello.');
  });

  it('reports a crash with its last error lines and starts again for the next render', async () => {
    const { worker, output, startCount } = setup();
    await expect(worker.render('crash', 'en', output('a'))).rejects.toThrow(
      /exit code 3\).*\n.*loading the model\nthe model ran out of memory/s,
    );
    await worker.render('Hello.', 'en', output('b'));
    expect(startCount()).toBe(2);
  });

  it('stops when idle and starts again when needed', async () => {
    const { worker, output, startCount } = setup(50);
    await worker.render('One.', 'en', output('a'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await worker.render('Two.', 'en', output('b'));
    expect(startCount()).toBe(2);
  });
});
