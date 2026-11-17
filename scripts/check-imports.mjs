// Fails when a package's source imports a package it may not: the runner, the plugin's MCP server
// and the web UI reach the backend over HTTP only, and the backend never reaches the runner.
// Tests may cross the lines, to run one package against another.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packagesPath = join(root, 'packages');

// The packages each one may import, by folder name. The UI reaches shared through its @shared alias.
const allowed = {
  shared: [],
  runner: ['shared'],
  mcp: ['shared'],
  backend: ['shared'],
  cli: ['shared', 'backend', 'runner', 'mcp'],
  ui: ['shared'],
};

const packageNames = Object.fromEntries(
  Object.keys(allowed).map((folder) => {
    const manifest = JSON.parse(readFileSync(join(packagesPath, folder, 'package.json'), 'utf8'));
    return [manifest.name, folder];
  }),
);
const sourceFile = /\.(ts|mts|vue)$/;
const specifiers =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\.meta\.resolve\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function filesIn(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : filesIn(path);
    return sourceFile.test(name) ? [path] : [];
  });
}

// The package folder a specifier points into, or null for a library or a file in the same package.
function targetOf(specifier, file) {
  if (specifier.startsWith('@shared/')) return 'shared';
  if (specifier.startsWith('.')) {
    const target = relative(packagesPath, resolve(file, '..', specifier));
    return target.startsWith('..') ? 'outside packages' : target.split(sep)[0];
  }
  const name = specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');
  return packageNames[name] ?? null;
}

const problems = [];
for (const [folder, imports] of Object.entries(allowed)) {
  for (const file of filesIn(join(packagesPath, folder, 'src'))) {
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(specifiers)) {
      const target = targetOf(specifier, file);
      if (target === null || target === folder || imports.includes(target)) continue;
      problems.push(`${relative(root, file)}: ${folder} may not import ${target} ('${specifier}')`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Forbidden imports between packages:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('Imports between packages are within their bounds.');
