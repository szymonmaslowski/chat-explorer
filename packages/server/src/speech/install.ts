import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { checkDiskSpace, InstallError } from '../dictation/install.js';
import { findOnPath } from '../dictation/availability.js';
import { chatterboxEnvironment, chatterboxPaths, speechWorkerScript } from './chatterbox.js';

const execFileAsync = promisify(execFile);

const pythonCommands = ['python3.13', 'python3.12', 'python3.11', 'python3'];
const supportedPython = /^3\.1[1-3]$/;
// The Python packages and the model take about 4.5 GB.
const neededBytes = 5 * 1024 * 1024 * 1024;

// resemble-perth, which both builds use, imports pkg_resources, which setuptools 81 removed.
export const speechPackages =
  process.platform === 'darwin' && process.arch === 'arm64'
    ? ['chatterbox-mlx==1.0.1', 'setuptools<81']
    : ['chatterbox-tts==0.1.7', 'setuptools<81'];

export async function installSpeech(input: { config: Config; log: (line: string) => void }) {
  const { config, log } = input;
  const paths = chatterboxPaths(config.speechPath);
  const python = await findPython();
  if (!python) {
    throw new InstallError(
      'Reading aloud with Chatterbox needs Python 3.11, 3.12 or 3.13. On a Mac: brew install python@3.13',
    );
  }
  await mkdir(config.speechPath, { recursive: true });
  await checkDiskSpace(config.speechPath, neededBytes);
  await rm(paths.installedMarker, { force: true });
  log(`Creating a Python environment in ${paths.venv} with ${python}…`);
  await run(python, ['-m', 'venv', paths.venv]);
  await run(paths.python, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
  log(`Installing ${speechPackages.join(', ')}…`);
  await run(paths.python, ['-m', 'pip', 'install', '--quiet', ...speechPackages]);
  log('Downloading the Chatterbox model (about 3 GB) and reading one sentence…');
  await run(
    paths.python,
    [speechWorkerScript, '--warm-up'],
    chatterboxEnvironment(config.speechPath),
  );
  await writeFile(paths.installedMarker, `${speechPackages.join('\n')}\n`);
}

export async function uninstallSpeech(config: Config) {
  const removed = [config.speechPath, config.speechCachePath].filter((path) => existsSync(path));
  for (const path of removed) await rm(path, { recursive: true, force: true });
  return removed;
}

async function findPython() {
  for (const command of pythonCommands) {
    const path = findOnPath(command);
    if (!path) continue;
    const { stdout } = await execFileAsync(path, [
      '-c',
      'import sys; print("%d.%d" % sys.version_info[:2])',
    ]).catch(() => ({ stdout: '' }));
    if (supportedPython.test(stdout.trim())) return path;
  }
  return null;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.on('error', (error) => reject(new InstallError(`${command} failed: ${error.message}`)));
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new InstallError(`${command} ${args.join(' ')} failed with exit code ${code}.`)),
    );
  });
}
