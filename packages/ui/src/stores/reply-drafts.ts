import { reactive } from 'vue';

const drafts = reactive(new Map<string, string>());
const newForks = reactive(new Map<string, boolean>());

export const replyDrafts = {
  has: (forkId: string) => drafts.has(forkId),
  get: (forkId: string) => drafts.get(forkId) ?? '',
  set: (forkId: string, text: string) => drafts.set(forkId, text),
  newFork: (forkId: string) => newForks.get(forkId) ?? false,
  setNewFork: (forkId: string, newFork: boolean) => newForks.set(forkId, newFork),
  restore(forkId: string, restored: string) {
    const current = drafts.get(forkId)?.trim();
    drafts.set(forkId, current ? `${restored}\n\n${current}` : restored);
  },
};
