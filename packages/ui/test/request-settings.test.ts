import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { Fork } from '@shared/types';
import ForkRequestSettings from '../src/components/ForkRequestSettings.vue';

vi.mock('../src/api', () => ({ api: {} }));

const fork = {
  id: 'fork_main',
  parentForkId: null,
  coordination: false,
  autonomous: [],
} as unknown as Fork;

describe('the Autonomous setting', () => {
  it('says the model, like container settings and credentials, always waits for approval', () => {
    const text = mount(ForkRequestSettings, { props: { fork } }).text();
    expect(text).toMatch(/Coding, hosts, registries, credentials and the model always wait/);
  });
});
