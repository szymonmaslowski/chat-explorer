import { readFileSync } from 'node:fs';

const packageJson: { version: string } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

export const packageVersion = packageJson.version;
