import { describe, expect, it } from 'vitest';
import type { RequestAction } from '@chat-explorer/shared/requests.js';
import type { RunnerCapabilities } from '@chat-explorer/shared/types.js';
import { newPrefixedId } from '../src/store/ids.js';
import { RequestStore } from '../src/store/requests.js';
import { createTestApp, createTestStore, seedConversation } from './helpers.js';

function setup(capabilities: RunnerCapabilities | null = null) {
  const context = createTestStore();
  const conversation = seedConversation(context.store);
  const requests = new RequestStore(context.store, () => capabilities);
  return { ...context, ...conversation, requests };
}

const forkAction = (overrides: Partial<Extract<RequestAction, { kind: 'fork' }>> = {}) =>
  ({
    kind: 'fork',
    forkId: newPrefixedId('fork'),
    title: 'Settings page',
    brief: 'Build the settings page.',
    awareness: 'aware',
    coding: false,
    model: null,
    hosts: [],
    registries: [],
    credentials: [],
    ...overrides,
  }) satisfies RequestAction;

const capabilities: RunnerCapabilities = {
  coding: true,
  codingOff: null,
  allowedHosts: ['github.com:443', '*.example.com:443'],
  privateHosts: [],
  credentials: [{ name: 'gh', type: 'token', hosts: ['github.com:443'] }],
  limits: { memory: '4g', cpus: null, processes: 100, workspaceLimitGb: 10 },
  configHash: 'x',
};

describe('action requests', () => {
  it('stores a request without running it, and joins the requests of one turn in one card', () => {
    const { store, requests, explorationId, mainForkId, events } = setup();
    const first = requests.request(mainForkId, 'fork', forkAction());
    expect(first.status).toBe('waiting for approval');
    expect(first.forkId).toMatch(/^fork_/);
    expect(store.snapshot(explorationId).forks).toHaveLength(1);
    const second = requests.request(mainForkId, 'fork', forkAction({ title: 'Sticky header' }));
    expect(second.requestId).toBe(first.requestId);
    const [request] = store.snapshot(explorationId).requests;
    expect(request?.items).toHaveLength(2);
    expect(request?.status).toBe('waiting');
    expect(request?.afterMessageId).toBe(store.fork(mainForkId).tipMessageId);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['request.created', 'request.updated']),
    );
  });

  it('approves all: the fork starts with its settings and its brief as the first message', () => {
    const { store, requests, mainForkId } = setup();
    const action = forkAction({ coding: true, awareness: 'separate', model: 'opus' });
    const { requestId, forkId } = requests.request(mainForkId, 'fork', action);
    const decided = requests.decide(requestId, { decision: 'approve' });
    expect(decided.status).toBe('approved');
    expect(decided.decidedBy).toBe('user');
    expect(decided.items[0]).toMatchObject({ outcome: 'done', resultId: forkId });
    const fork = store.fork(forkId!);
    expect(fork).toMatchObject({
      parentForkId: mainForkId,
      summary: 'Settings page',
      coding: true,
      awareness: 'separate',
      model: 'opus',
    });
    expect(fork.baseMessageId).toBe(store.fork(mainForkId).tipMessageId);
    const read = store.readFork(forkId!);
    expect(read.messages.at(-1)).toMatchObject({ role: 'user', text: 'Build the settings page.' });
  });

  it('approves some: unticked items stay undone and say so', () => {
    const { store, requests, explorationId, mainForkId } = setup();
    const a = requests.request(mainForkId, 'fork', forkAction({ title: 'A' }));
    const b = requests.request(mainForkId, 'fork', forkAction({ title: 'B' }));
    const request = requests.get(a.requestId);
    const decided = requests.decide(a.requestId, {
      decision: 'approve',
      items: [{ id: request.items[1]!.id, selected: false }],
    });
    expect(decided.items.map((item) => item.outcome)).toEqual(['done', 'unticked']);
    expect(store.snapshot(explorationId).forks.map((fork) => fork.id)).not.toContain(b.forkId);
  });

  it('rejects all, with the reason', () => {
    const { store, requests, explorationId, mainForkId } = setup();
    const { requestId } = requests.request(mainForkId, 'fork', forkAction());
    const decided = requests.decide(requestId, { decision: 'reject', reason: 'Not now' });
    expect(decided).toMatchObject({ status: 'rejected', reason: 'Not now', decidedBy: 'user' });
    expect(decided.items[0]?.outcome).toBe('rejected');
    expect(store.snapshot(explorationId).forks).toHaveLength(1);
  });

  it('runs the edited version and keeps both versions', () => {
    const { store, requests, mainForkId } = setup();
    const original = forkAction({ coding: true });
    const { requestId, forkId } = requests.request(mainForkId, 'fork', original);
    const itemId = requests.get(requestId).items[0]!.id;
    const edited = { ...original, brief: 'Build it smaller.', coding: false };
    const decided = requests.decide(requestId, {
      decision: 'approve',
      items: [{ id: itemId, selected: true, action: edited }],
    });
    expect(decided.items[0]?.original).toEqual(original);
    expect(decided.items[0]?.final).toEqual(edited);
    expect(store.fork(forkId!).coding).toBe(false);
    expect(store.readFork(forkId!).messages.at(-1)?.text).toBe('Build it smaller.');
  });

  it("refuses an edit that changes the item's kind or the id it creates", () => {
    const { requests, mainForkId } = setup();
    const original = forkAction();
    const { requestId } = requests.request(mainForkId, 'fork', original);
    const itemId = requests.get(requestId).items[0]!.id;
    expect(() =>
      requests.decide(requestId, {
        decision: 'approve',
        items: [{ id: itemId, selected: true, action: { ...original, forkId: 'fork_0000000000' } }],
      }),
    ).toThrow(/id/);
    expect(requests.get(requestId).status).toBe('waiting');
  });

  it('refuses an unknown fork and a fork of another chat', () => {
    const { store, requests, mainForkId } = setup();
    const other = seedConversation(store);
    expect(() =>
      requests.request(mainForkId, 'fork', {
        kind: 'message',
        forkId: 'fork_nothere00',
        text: 'Hi',
      }),
    ).toThrow(/not found/);
    expect(() =>
      requests.request(mainForkId, 'fork', {
        kind: 'message',
        forkId: other.mainForkId,
        text: 'Hi',
      }),
    ).toThrow(/not found/);
  });

  it('refuses a second decision on the same request', () => {
    const { requests, mainForkId } = setup();
    const { requestId } = requests.request(mainForkId, 'fork', forkAction());
    requests.decide(requestId, { decision: 'reject' });
    expect(() => requests.decide(requestId, { decision: 'approve' })).toThrow(/already decided/);
  });

  it('runs a message to a fork of the same batch after the fork, in order', () => {
    const { store, requests, mainForkId } = setup();
    const { requestId, forkId } = requests.request(mainForkId, 'fork', forkAction());
    requests.request(mainForkId, 'fork', { kind: 'message', forkId: forkId!, text: 'And tests.' });
    const decided = requests.decide(requestId, { decision: 'approve' });
    expect(decided.items.map((item) => item.outcome)).toEqual(['done', 'done']);
    const texts = store
      .readFork(forkId!)
      .messages.slice(-2)
      .map((message) => message.text);
    expect(texts[0]).toBe('Build the settings page.');
    expect(texts[1]).toContain('And tests.');
  });

  it("marks a message to an unticked fork 'not run'", () => {
    const { store, requests, explorationId, mainForkId } = setup();
    const { requestId, forkId } = requests.request(mainForkId, 'fork', forkAction());
    requests.request(mainForkId, 'fork', { kind: 'message', forkId: forkId!, text: 'And tests.' });
    const request = requests.get(requestId);
    const decided = requests.decide(requestId, {
      decision: 'approve',
      items: [{ id: request.items[0]!.id, selected: false }],
    });
    expect(decided.items[1]).toMatchObject({
      outcome: 'skipped',
      detail: "Not run: its fork wasn't created.",
    });
    expect(store.snapshot(explorationId).forks).toHaveLength(1);
  });

  it('lets a later card name a fork a waiting card will create', () => {
    const { store, requests, mainForkId } = setup();
    const first = requests.request(mainForkId, 'fork', forkAction());
    // The user answers in between, so the next request starts a new card.
    store.addRunnerAnswer(mainForkId, 'Asked for the fork.');
    const second = requests.request(mainForkId, 'fork', {
      kind: 'message',
      forkId: first.forkId!,
      text: 'Hello',
    });
    expect(second.requestId).not.toBe(first.requestId);
    requests.decide(first.requestId, { decision: 'reject' });
    const decided = requests.decide(second.requestId, { decision: 'approve' });
    expect(decided.items[0]?.outcome).toBe('skipped');
  });

  it("applies the runner's ceilings when asked and when edited values run", () => {
    const { requests, mainForkId } = setup(capabilities);
    expect(() =>
      requests.request(mainForkId, 'fork', forkAction({ hosts: ['evil.org:443'] })),
    ).toThrow(/beyond the hosts/);
    expect(() =>
      requests.request(mainForkId, 'fork', forkAction({ credentials: ['nope'] })),
    ).toThrow(/no credential/);
    const ok = forkAction({ hosts: ['api.example.com:443'], credentials: ['gh'] });
    const { requestId } = requests.request(mainForkId, 'fork', ok);
    const itemId = requests.get(requestId).items[0]!.id;
    const decided = requests.decide(requestId, {
      decision: 'approve',
      items: [{ id: itemId, selected: true, action: { ...ok, hosts: ['evil.org:443'] } }],
    });
    expect(decided.items[0]).toMatchObject({ outcome: 'failed' });
    expect(decided.items[0]?.detail).toMatch(/beyond the hosts/);
  });

  it('changes the settings of an existing fork', () => {
    const { store, requests, mainForkId, answer } = setup();
    const fork = store.forkAtAnswer(answer.id);
    const { requestId } = requests.request(mainForkId, 'fork', {
      kind: 'fork_settings',
      forkId: fork.id,
      changes: { coding: true, title: 'Coding fork', model: 'opus', registries: ['npm'] },
    });
    requests.decide(requestId, { decision: 'approve' });
    expect(store.fork(fork.id)).toMatchObject({
      coding: true,
      summary: 'Coding fork',
      model: 'opus',
      network: { hosts: [], registries: ['npm'], credentials: [] },
    });
  });

  it('reports decided requests to the Claude that asked, once', () => {
    const { requests, mainForkId } = setup();
    const original = forkAction();
    const { requestId } = requests.request(mainForkId, 'fork', original);
    expect(requests.takeOutcomes(mainForkId)).toBeNull();
    const itemId = requests.get(requestId).items[0]!.id;
    requests.decide(requestId, {
      decision: 'approve',
      items: [{ id: itemId, selected: true, action: { ...original, brief: 'Smaller.' } }],
    });
    const text = requests.takeOutcomes(mainForkId);
    expect(text).toContain(`Request ${requestId}, approved by the user`);
    expect(text).toContain('done');
    expect(text).toContain('The user edited it; now brief: "Smaller."');
    expect(requests.takeOutcomes(mainForkId)).toBeNull();
  });
});

describe('the decide API', () => {
  it('approves over HTTP and shows the request in the snapshot and the change log', async () => {
    const { store, request, runs: _runs } = createTestApp();
    const { mainForkId, explorationId } = seedConversation(store);
    const requests = new RequestStore(store);
    const seq = store.latestChangeSeq();
    const { requestId, forkId } = requests.request(mainForkId, 'fork', forkAction());
    const changes = store.changesSince(explorationId, seq);
    expect(changes.requests.map((each) => each.id)).toEqual([requestId]);
    const response = await request(`/api/requests/${requestId}/decide`, {
      method: 'POST',
      json: { decision: 'approve' },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('approved');
    expect(store.fork(forkId!).parentForkId).toBe(mainForkId);
    const again = await request(`/api/requests/${requestId}/decide`, {
      method: 'POST',
      json: { decision: 'reject' },
    });
    expect(again.status).toBe(409);
  });
});

describe('the autonomous setting', () => {
  it('runs an allowed area at once, logged with the setting as the decider', () => {
    const { store, requests, mainForkId, answer } = setup();
    const child = store.forkAtAnswer(answer.id);
    store.setForkAutonomous(mainForkId, ['messages']);
    const result = requests.request(mainForkId, 'fork', {
      kind: 'message',
      forkId: child.id,
      text: 'Carry on.',
    });
    expect(result.status).toBe('done');
    expect(store.readFork(child.id).messages.at(-1)?.text).toContain('Carry on.');
    const request = requests.get(result.requestId);
    expect(request).toMatchObject({ status: 'approved', decidedBy: 'autonomous' });
    // Claude heard it in the tool's result.
    expect(requests.takeOutcomes(mainForkId)).toBeNull();
  });

  it('needs a card for an area that is not ticked', () => {
    const { store, requests, mainForkId, answer } = setup();
    const child = store.forkAtAnswer(answer.id);
    store.setForkAutonomous(mainForkId, ['forks']);
    const result = requests.request(mainForkId, 'fork', {
      kind: 'message',
      forkId: child.id,
      text: 'Carry on.',
    });
    expect(result.status).toBe('waiting for approval');
  });

  it('never covers container settings, credentials or the model', () => {
    const { store, requests, mainForkId, answer } = setup();
    const child = store.forkAtAnswer(answer.id);
    store.setForkAutonomous(mainForkId, ['forks', 'fork_options']);
    for (const action of [
      forkAction({ coding: true }),
      forkAction({ registries: ['npm'] }),
      forkAction({ credentials: ['gh'] }),
      forkAction({ hosts: ['api.example.com:443'] }),
      forkAction({ model: 'opus' }),
    ]) {
      expect(requests.request(mainForkId, 'fork', action).status).toBe('waiting for approval');
    }
    const settings = (changes: Record<string, unknown>) =>
      requests.request(mainForkId, 'fork', { kind: 'fork_settings', forkId: child.id, changes })
        .status;
    expect(settings({ coding: true })).toBe('waiting for approval');
    expect(settings({ registries: ['npm'] })).toBe('waiting for approval');
    expect(settings({ title: 'Renamed', awareness: 'separate' })).toBe('done');
    expect(store.fork(child.id)).toMatchObject({ summary: 'Renamed', awareness: 'separate' });
  });

  it('turns the sixth new fork within an hour into a card', () => {
    const { store, requests, mainForkId, clock } = setup();
    store.setForkAutonomous(mainForkId, ['forks']);
    const statuses = Array.from(
      { length: 6 },
      () => requests.request(mainForkId, 'fork', forkAction()).status,
    );
    expect(statuses).toEqual(['done', 'done', 'done', 'done', 'done', 'waiting for approval']);
    clock.now += 60 * 60 * 1000 + 1;
    expect(requests.request(mainForkId, 'fork', forkAction()).status).toBe('done');
  });

  it("takes the cap from the runner's config", () => {
    const { store, requests, mainForkId } = setup({ ...capabilities, autonomousForksPerHour: 1 });
    store.setForkAutonomous(mainForkId, ['forks']);
    expect(requests.request(mainForkId, 'fork', forkAction()).status).toBe('done');
    expect(requests.request(mainForkId, 'fork', forkAction()).status).toBe('waiting for approval');
  });

  it('is only for the main fork to coordinate', () => {
    const { store, mainForkId, answer } = setup();
    const child = store.forkAtAnswer(answer.id);
    expect(store.setForkCoordination(mainForkId, true).coordination).toBe(true);
    expect(() => store.setForkCoordination(child.id, true)).toThrow(/main fork/);
    expect(() => store.setForkAutonomous(child.id, ['nope' as never])).toThrow(/no autonomous/);
  });
});
