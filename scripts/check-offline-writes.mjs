// Fails when the web UI writes to the daemon around the outbox. Every write goes into the outbox
// (packages/ui/src/stores/outbox.ts), which keeps it on the device until the daemon has it; see
// docs/offline-writes.md. Each method of the UI's `api` must be listed below, so a new one can't
// slip in unsorted, and a direct call is allowed only to the methods listed as reads, as direct on
// purpose, or as debt still to move into the outbox.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const uiSource = join(root, 'packages', 'ui', 'src');
const apiFile = join(uiSource, 'api.ts');
const outboxFile = join(uiSource, 'stores', 'outbox.ts');

// Reads change nothing, so they need no outbox.
const reads = [
  'attemptActivities',
  'changes',
  'codingCapacity',
  'listExplorations',
  'messageBodies',
  'replyDraft',
  'runnerCapabilities',
  'settings',
  'snapshot',
];

// Writes that go straight to the daemon on purpose, each with why. A control that calls one is
// disabled while offline (`offline` and `notOffline` from lib/online.ts) or shows the failure.
const direct = {
  speech: 'computes audio and stores nothing',
  transcribe: 'computes text and stores nothing',
  uploadFile: 'a file body is too big for the outbox in localStorage; the draft keeps its state',
  deleteFile: 'removes an upload that only the draft knew of',
  stopFork: 'acts on an answer running now, so it is useless later',
  retryFork: 'acts on a failed run now, so it is useless later',
  restartContainer: 'acts on a container running now, so it is useless later',
  deleteExploration: 'a confirmed, destructive decision that must not run later by surprise',
};

// Direct today, but they should go through the outbox. Move one, then take it off this list: the
// check fails while a listed method is no longer called directly, so the list only shrinks.
const debt = [
  'addBoardColumn',
  'archive',
  'archiveFork',
  'collapseFork',
  'createExploration',
  'deleteBoardColumn',
  'expandCollapsedChildren',
  'moveFork',
  'renameBoardColumn',
  'reorderBoardColumn',
  'setDefaultPage',
  'setForkAwareness',
  'setForkCoding',
  'setForkModel',
  'setForkNetwork',
  'splitFork',
  'unarchive',
  'unarchiveFork',
];

const apiCalls = /\bapi\.(\w+)\b/g;
const sourceFile = /\.(ts|vue)$/;

function filesIn(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return filesIn(path);
    return sourceFile.test(name) ? [path] : [];
  });
}

function apiMethods() {
  const source = readFileSync(apiFile, 'utf8');
  const body = source.slice(source.indexOf('export const api = {'));
  return new Set([...body.matchAll(/^ {2}(\w+):/gm)].map(([, name]) => name));
}

const methods = apiMethods();
const sentByOutbox = new Set(
  [...readFileSync(outboxFile, 'utf8').matchAll(apiCalls)].map(([, name]) => name),
);
const allowedDirect = new Set([...reads, ...Object.keys(direct), ...debt]);
const problems = [];
const calledDirectly = new Set();

for (const file of filesIn(uiSource)) {
  if (file === apiFile || file === outboxFile) continue;
  for (const [, name] of readFileSync(file, 'utf8').matchAll(apiCalls)) {
    calledDirectly.add(name);
    if (allowedDirect.has(name)) continue;
    problems.push(
      `${relative(root, file)}: api.${name} writes around the outbox. Add a Change to stores/outbox.ts and call outbox.add, or list it in scripts/check-offline-writes.mjs with the reason.`,
    );
  }
}

for (const name of methods) {
  if (allowedDirect.has(name) || sentByOutbox.has(name)) continue;
  problems.push(
    `packages/ui/src/api.ts: api.${name} is not sorted. Send it from stores/outbox.ts, or list it in scripts/check-offline-writes.mjs as a read or a direct write with the reason.`,
  );
}

for (const name of [...reads, ...Object.keys(direct), ...debt]) {
  if (!methods.has(name)) {
    problems.push(`scripts/check-offline-writes.mjs: api.${name} no longer exists; remove it.`);
  }
}

for (const name of debt) {
  if (!calledDirectly.has(name)) {
    problems.push(
      `scripts/check-offline-writes.mjs: api.${name} is no longer called around the outbox; take it off the debt list.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`Writes around the outbox (see docs/offline-writes.md):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(
  `The UI's writes go through the outbox, apart from ${Object.keys(direct).length} direct on purpose and ${debt.length} still to move.`,
);
