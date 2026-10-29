import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const uiDist = fileURLToPath(new URL('../../ui/dist', import.meta.url));
const plugin = fileURLToPath(new URL('../../../plugin', import.meta.url));
const dist = fileURLToPath(new URL('../dist', import.meta.url));

if (!existsSync(uiDist)) {
  console.error('UI build not found. Run `pnpm --filter ui build` first.');
  process.exit(1);
}
cpSync(uiDist, `${dist}/ui`, { recursive: true });
// Background sessions load this copy, so they always match the daemon's version.
cpSync(plugin, `${dist}/plugin`, { recursive: true });
const speechWorker = fileURLToPath(new URL('../src/speech/speech_worker.py', import.meta.url));
cpSync(speechWorker, `${dist}/speech/speech_worker.py`);
