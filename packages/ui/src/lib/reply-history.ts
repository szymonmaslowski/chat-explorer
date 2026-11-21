// Going through the messages sent in a fork from the reply box, as a shell goes through its
// history. `sent` runs from the oldest to the newest; `at` is the one shown, null while the box
// holds what was being typed, kept in `draft`.
export interface ReplyHistory {
  at: number | null;
  draft: string;
}

export const atDraft = (): ReplyHistory => ({ at: null, draft: '' });

// One message further back, or null when there is none.
export function stepBack(sent: string[], history: ReplyHistory, typed: string) {
  if (history.at === null) {
    if (sent.length === 0) return null;
    const at = sent.length - 1;
    return { history: { at, draft: typed }, text: sent[at]! };
  }
  if (history.at === 0) return null;
  const at = history.at - 1;
  return { history: { ...history, at }, text: sent[at]! };
}

// One message forward, and past the newest back to what was being typed; null at the draft.
export function stepForward(sent: string[], history: ReplyHistory) {
  if (history.at === null) return null;
  if (history.at >= sent.length - 1) return { history: atDraft(), text: history.draft };
  const at = history.at + 1;
  return { history: { ...history, at }, text: sent[at]! };
}
