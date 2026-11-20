// A card cannot sit inside a code block or a table, so the comments on text in one open after it
// as a whole. Such a card is away from its text, and shows what it quotes.
export function sitsApartFromText(range: Range) {
  const end = range.endContainer;
  const element = end instanceof Element ? end : end.parentElement;
  const root = element?.closest('[data-anchor-root]');
  const whole = element?.closest('pre, table');
  return !!root && !!whole && root.contains(whole);
}
