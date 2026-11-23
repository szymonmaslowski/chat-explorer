import type { ActionRequest, RequestItem } from '@shared/requests';
import type { MessageHead } from '@shared/types';

// Where each of a fork's request cards shows: after the message Claude asked under and the
// answers that follow it, before the next message of the user's. One whose message isn't on the
// path shows at the end.
export const endOfFork = 'end';

export function requestPlacement(requests: ActionRequest[], path: MessageHead[]) {
  const index = new Map(path.map((message, position) => [message.id, position]));
  const placed = new Map<string, ActionRequest[]>();
  for (const request of [...requests].sort((a, b) => a.createdAt - b.createdAt)) {
    let at = request.afterMessageId === null ? undefined : index.get(request.afterMessageId);
    let key = endOfFork;
    if (at !== undefined) {
      while (path[at + 1]?.role === 'assistant') at += 1;
      key = path[at]!.id;
    }
    placed.set(key, [...(placed.get(key) ?? []), request]);
  }
  return placed;
}

export const waitingRequests = (requests: Iterable<ActionRequest>, forkId: string) =>
  [...requests]
    .filter((request) => request.forkId === forkId && request.status === 'waiting')
    .sort((a, b) => a.createdAt - b.createdAt);

// Forks with a card waiting for the user, by id.
export function forksWithWaitingRequests(requests: Iterable<ActionRequest>) {
  const forkIds = new Set<string>();
  for (const request of requests) if (request.status === 'waiting') forkIds.add(request.forkId);
  return forkIds;
}

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function decisionSummary(request: ActionRequest) {
  if (request.status === 'waiting') {
    const count = request.items.length;
    return `${count} request${count === 1 ? '' : 's'} · waiting for you`;
  }
  const at = request.decidedAt === null ? '' : ` · ${time(request.decidedAt)}`;
  if (request.status === 'rejected') return `Rejected${at}`;
  const done = request.items.filter((item) => item.outcome === 'done').length;
  const by = request.decidedBy === 'autonomous' ? ' by the autonomous setting' : '';
  return `Approved ${done} of ${request.items.length}${by}${at}`;
}

export function outcomeLabel(item: RequestItem) {
  switch (item.outcome) {
    case 'done':
      return 'Done';
    case 'failed':
      return `Failed: ${item.detail ?? ''}`.trim();
    case 'skipped':
      return item.detail ?? 'Not run';
    case 'unticked':
      return 'Not requested';
    case 'rejected':
      return 'Rejected';
    default:
      return '';
  }
}
