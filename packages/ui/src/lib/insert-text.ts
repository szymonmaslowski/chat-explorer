export function insertText(value: string, cursor: number, text: string) {
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const spaceBefore = before && !/\s$/.test(before) ? ' ' : '';
  const spaceAfter = after && !/^\s/.test(after) ? ' ' : '';
  return `${before}${spaceBefore}${text}${spaceAfter}${after}`;
}

export function insertAtCursor(textarea: HTMLTextAreaElement | null, value: string, text: string) {
  return insertText(value, textarea?.selectionEnd ?? value.length, text);
}
