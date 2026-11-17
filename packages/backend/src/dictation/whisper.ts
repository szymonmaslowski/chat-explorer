import { execFile } from 'node:child_process';

export interface WhisperRun {
  code: number;
  stdout: string;
  stderr: string;
}

export type WhisperRunner = (
  whisperPath: string,
  args: string[],
  signal: AbortSignal,
) => Promise<WhisperRun>;

export function whisperArguments(input: {
  modelPath: string;
  audioPath: string;
  language: string;
  hint: string;
}) {
  return [
    '-m',
    input.modelPath,
    '-f',
    input.audioPath,
    '-l',
    input.language,
    '-nt',
    '-np',
    ...(input.hint ? ['--prompt', input.hint] : []),
  ];
}

export const runWhisper: WhisperRunner = (whisperPath, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      whisperPath,
      args,
      { signal, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (signal.aborted) return reject(signal.reason);
        if (error && typeof error.code !== 'number') return reject(error);
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
  });

export function transcriptText(stdout: string) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

export function silentWav(seconds: number, sampleRate = 16_000) {
  const dataBytes = seconds * sampleRate * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}
