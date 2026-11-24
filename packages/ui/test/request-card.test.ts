import { mount, RouterLinkStub } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionRequest, RequestAction } from '@shared/requests';
import type { MessageHead } from '@shared/types';
import RequestCard from '../src/components/RequestCard.vue';
import { decisionSummary, requestPlacement, waitingRequests } from '../src/lib/requests';

const decideRequest = vi.fn();
vi.mock('../src/api', () => ({
  api: { decideRequest: (...args: unknown[]) => decideRequest(...args) },
}));

const forkAction: RequestAction = {
  kind: 'fork',
  forkId: 'fork_new0000000',
  title: 'Settings page',
  brief: 'Build the settings page.',
  awareness: 'aware',
  coding: true,
  model: null,
  hosts: [],
  registries: [],
  credentials: [],
};

const request = (overrides: Partial<ActionRequest> = {}): ActionRequest => ({
  id: 'req_0000000001',
  explorationId: 'chat_x',
  forkId: 'fork_main',
  afterMessageId: 'm2',
  requestedBy: 'fork',
  items: [
    { id: 'i1', original: forkAction, final: null, outcome: null, detail: null, resultId: null },
    {
      id: 'i2',
      original: { kind: 'message', forkId: 'fork_new0000000', text: 'And tests.' },
      final: null,
      outcome: null,
      detail: null,
      resultId: null,
    },
  ],
  status: 'waiting',
  decidedBy: null,
  decidedAt: null,
  reason: null,
  allowedAreas: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const card = (value: ActionRequest) =>
  mount(RequestCard, {
    props: {
      request: value,
      explorationId: 'chat_x',
      forks: new Map(),
      noteGroups: new Map(),
      notes: new Map(),
      credentialNames: ['gh'],
    },
    global: { stubs: { RouterLink: RouterLinkStub } },
  });

const button = (wrapper: ReturnType<typeof card>, text: string) =>
  wrapper.findAll('button').find((each) => each.text().startsWith(text))!;

describe('request card', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    decideRequest.mockReset();
    decideRequest.mockImplementation(async (_id, decision) => ({
      ...request(),
      status: decision.decision === 'approve' ? 'approved' : 'rejected',
    }));
  });
  afterEach(() => vi.useRealTimers());

  it('approves on the second click, with the ticks and the edits', async () => {
    const wrapper = card(request());
    await wrapper.findAll('input[type="checkbox"]')[1]!.setValue(false);
    expect(button(wrapper, 'Approve').text()).toBe('Approve 1');
    await wrapper.find('[aria-label="Show and edit the details"]').trigger('click');
    await wrapper.find('textarea').setValue('Build it smaller.');
    expect(wrapper.find('.edited').exists()).toBe(true);
    await button(wrapper, 'Approve').trigger('click');
    expect(decideRequest).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Sure?');
    await wrapper
      .findAll('button')
      .find((each) => each.text() === 'Sure?')!
      .trigger('click');
    expect(decideRequest).toHaveBeenCalledWith('req_0000000001', {
      decision: 'approve',
      items: [
        { id: 'i1', selected: true, action: { ...forkAction, brief: 'Build it smaller.' } },
        {
          id: 'i2',
          selected: false,
          action: { kind: 'message', forkId: 'fork_new0000000', text: 'And tests.' },
        },
      ],
    });
  });

  it('asks "Sure?" for Reject too, and lets the arming lapse', async () => {
    const wrapper = card(request());
    await button(wrapper, 'Reject').trigger('click');
    expect(wrapper.text()).toContain('Sure?');
    vi.advanceTimersByTime(3_100);
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('Sure?');
    await button(wrapper, 'Reject').trigger('click');
    await wrapper.find('.reason-input').setValue('Not now');
    await wrapper
      .findAll('button')
      .find((each) => each.text() === 'Sure?')!
      .trigger('click');
    expect(decideRequest).toHaveBeenCalledWith('req_0000000001', {
      decision: 'reject',
      reason: 'Not now',
    });
  });

  it('warns about a credential', async () => {
    const wrapper = card(
      request({
        items: [
          {
            id: 'i1',
            original: { ...forkAction, credentials: ['gh'] },
            final: null,
            outcome: null,
            detail: null,
            resultId: null,
          },
        ],
      }),
    );
    expect(wrapper.find('.warning').text()).toContain('the fork can read it');
  });

  it('shows a decided card read-only, with outcomes and the original of edited fields', () => {
    const wrapper = card(
      request({
        status: 'approved',
        decidedBy: 'user',
        decidedAt: 1,
        items: [
          {
            id: 'i1',
            original: forkAction,
            final: { ...forkAction, brief: 'Smaller.' },
            outcome: 'done',
            detail: null,
            resultId: 'fork_new0000000',
          },
          {
            id: 'i2',
            original: { kind: 'message', forkId: 'fork_x000000000', text: 'Hi' },
            final: { kind: 'message', forkId: 'fork_x000000000', text: 'Hi' },
            outcome: 'skipped',
            detail: "Not run: its fork wasn't created.",
            resultId: null,
          },
        ],
      }),
    );
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(wrapper.text()).toContain('Approved 1 of 2');
    expect(wrapper.text()).toContain('Edited brief. Claude asked for:');
    expect(wrapper.text()).toContain('Build the settings page.');
    expect(wrapper.text()).toContain("Not run: its fork wasn't created.");
    expect(wrapper.findComponent(RouterLinkStub).props('to')).toBe('/e/chat_x/f/fork_new0000000');
  });
});

describe('request placement', () => {
  const head = (id: string, role: 'user' | 'assistant'): MessageHead => ({
    id,
    explorationId: 'chat_x',
    forkId: 'fork_main',
    parentId: null,
    role,
    source: 'live',
    createdAt: 0,
    readAt: null,
    answers: [],
  });
  const path = [
    head('m1', 'user'),
    head('m2', 'user'),
    head('m3', 'assistant'),
    head('m4', 'user'),
  ];

  it("shows a card after the turn's answers, and one off the path at the end", () => {
    const placed = requestPlacement(
      [
        request(),
        request({ id: 'req_2', afterMessageId: 'gone' }),
        request({ id: 'req_3', afterMessageId: 'm4' }),
      ],
      path,
    );
    expect(placed.get('m3')?.map((each) => each.id)).toEqual(['req_0000000001']);
    expect(placed.get('m4')?.map((each) => each.id)).toEqual(['req_3']);
    expect(placed.get('end')?.map((each) => each.id)).toEqual(['req_2']);
  });

  it('lists the waiting cards oldest first, and sums up a decision', () => {
    const waiting = waitingRequests(
      [
        request({ id: 'b', createdAt: 2 }),
        request({ id: 'a', createdAt: 1 }),
        request({ id: 'c', status: 'rejected' }),
      ],
      'fork_main',
    );
    expect(waiting.map((each) => each.id)).toEqual(['a', 'b']);
    expect(decisionSummary(request())).toBe('2 requests · waiting for you');
    expect(decisionSummary(request({ status: 'rejected', decidedAt: null }))).toBe('Rejected');
  });
});

describe('request bar', () => {
  it('counts the waiting requests, jumps to the oldest card and lists every card', async () => {
    const { default: RequestBar } = await import('../src/components/RequestBar.vue');
    const first = request();
    const second = request({ id: 'req_2', createdAt: 2 });
    document.body.innerHTML = `<section id="r-${first.id}"></section><section id="r-req_2"></section>`;
    window.scrollTo = (() => {}) as typeof window.scrollTo;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const wrapper = mount(RequestBar, { props: { requests: [first, second] } });
    expect(wrapper.find('.jump').text()).toBe('4 requests waiting');
    await wrapper.find('.jump').trigger('click');
    expect(document.getElementById(`r-${first.id}`)!.classList).toContain('flash');
    await wrapper.find('.toggle').trigger('click');
    const lines = wrapper.findAll('.line');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.text()).toContain('Start a new fork "Settings page"');
    expect(lines[0]!.text()).toContain('and 1 more');
    await wrapper.setProps({ requests: [] });
    expect(wrapper.find('.request-bar').exists()).toBe(false);
  });
});

describe('attention', () => {
  it('puts a waiting request above an unseen answer', async () => {
    const { forkAttention, strongestAttention } = await import('../src/lib/read-state');
    const attention = forkAttention({
      forks: new Map(),
      forkRuns: new Map(),
      messages: new Map([
        [
          'm1',
          {
            id: 'm1',
            explorationId: 'chat_x',
            forkId: 'fork_main',
            parentId: null,
            role: 'assistant',
            source: 'live',
            createdAt: 0,
            readAt: null,
            answers: [],
          },
        ],
      ]),
      requests: new Map([
        ['a', request()],
        ['b', request({ id: 'b', forkId: 'fork_done', status: 'approved' })],
      ]),
    });
    expect(attention.get('fork_main')).toBe('request');
    expect(attention.has('fork_done')).toBe(false);
    expect(strongestAttention(['unread', 'request'])).toBe('request');
    expect(strongestAttention([undefined, 'unread'])).toBe('unread');
  });
});

describe("the card's allow checkboxes", () => {
  const notesItem = {
    id: 'n1',
    original: {
      kind: 'notes',
      groupId: 'g1',
      notes: [{ topic: 'A' }],
      sourceMessageId: null,
    } as RequestAction,
    final: null,
    outcome: null,
    detail: null,
    resultId: null,
  };
  const mixed = () => request({ items: [request().items[0]!, request().items[1]!, notesItem] });

  beforeEach(() => {
    vi.useFakeTimers();
    decideRequest.mockReset();
    decideRequest.mockImplementation(async () => request({ status: 'approved' }));
  });
  afterEach(() => vi.useRealTimers());

  const labels = (wrapper: ReturnType<typeof card>) =>
    wrapper.findAll('.allow label').map((label) => label.text());

  it('offers one per area the setting can cover, none for a coding fork', () => {
    // The fork item has coding on, so "new forks" is not offered.
    const wrapper = card(mixed());
    expect(labels(wrapper)).toEqual([
      'Allow notes actions without asking in this fork',
      'Allow messages to forks without asking in this fork',
    ]);
    const plain = card(
      request({
        items: [
          {
            ...request().items[0]!,
            original: { ...forkAction, coding: false },
          },
        ],
      }),
    );
    expect(labels(plain)[0]).toContain('Allow new forks without asking in this fork');
    const withModel = card(
      request({
        items: [
          { ...request().items[0]!, original: { ...forkAction, coding: false, model: 'opus' } },
        ],
      }),
    );
    expect(labels(withModel)).toEqual([]);
  });

  it('sends the ticked areas with Approve only, and only for ticked items', async () => {
    const wrapper = card(mixed());
    const boxes = wrapper.findAll('.allow input');
    await boxes[0]!.setValue(true);
    await boxes[1]!.setValue(true);
    expect(wrapper.find('.allow .warning').exists()).toBe(true);
    // Unticking the message item leaves its area disabled and out of the approval.
    await wrapper.findAll('.item input[type="checkbox"]')[1]!.setValue(false);
    expect((wrapper.findAll('.allow input')[1]!.element as HTMLInputElement).disabled).toBe(true);
    await button(wrapper, 'Approve').trigger('click');
    await wrapper
      .findAll('button')
      .find((each) => each.text() === 'Sure?')!
      .trigger('click');
    expect(decideRequest.mock.calls[0]![1]).toMatchObject({ allowAreas: ['notes'] });

    const rejecting = card(mixed());
    await rejecting.findAll('.allow input')[0]!.setValue(true);
    await button(rejecting, 'Reject').trigger('click');
    await rejecting
      .findAll('button')
      .find((each) => each.text() === 'Sure?')!
      .trigger('click');
    expect(decideRequest.mock.calls[1]![1]).not.toHaveProperty('allowAreas');
  });
});
