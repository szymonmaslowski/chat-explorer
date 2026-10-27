import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const uiDist = fileURLToPath(new URL('../../ui/dist', import.meta.url));
const target = fileURLToPath(new URL('../dist/ui', import.meta.url));

if (!existsSync(uiDist)) {
  console.error('UI build not found. Run `pnpm --filter ui build` first.');
  process.exit(1);
}
cpSync(uiDist, target, { recursive: true });
