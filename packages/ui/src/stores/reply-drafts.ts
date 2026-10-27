import { reactive } from 'vue';

const drafts = reactive(new Map<string, string>());

export const replyDrafts = {
  get: (forkId: string) => drafts.get(forkId) ?? '',
  set: (forkId: string, text: string) => drafts.set(forkId, text),
  restore(forkId: string, restored: string) {
    const current = drafts.get(forkId)?.trim();
    drafts.set(forkId, current ? `${restored}\n\n${current}` : restored);
  },
};
