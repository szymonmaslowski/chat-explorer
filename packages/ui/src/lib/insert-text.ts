import { nextTick, type Ref } from 'vue';

export function insertText(value: string, cursor: number, text: string) {
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const spaceBefore = before && !/\s$/.test(before) ? ' ' : '';
  const spaceAfter = after && !/^\s/.test(after) ? ' ' : '';
  return `${before}${spaceBefore}${text}${spaceAfter}${after}`;
}

// The caret ends up right after the inserted text, so dictating again continues from there.
// It can only move once Vue has put the new text into the textarea.
export function insertAtCursor(
  textarea: HTMLTextAreaElement | null,
  model: Ref<string>,
  text: string,
) {
  const cursor = textarea?.selectionEnd ?? model.value.length;
  const caret = insertText(model.value.slice(0, cursor), cursor, text).length;
  model.value = insertText(model.value, cursor, text);
  if (textarea) void nextTick(() => textarea.setSelectionRange(caret, caret));
}
