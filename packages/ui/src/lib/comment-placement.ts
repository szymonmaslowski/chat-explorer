// A card cannot sit inside a code block or a table, so the comments on text in one open after it
// as a whole. Returns that block, or null when the card can sit right after its text.
export function wholeBlockAround(range: Range) {
  const end = range.endContainer;
  const element = end instanceof Element ? end : end.parentElement;
  const root = element?.closest('[data-anchor-root]');
  const whole = element?.closest('pre, table');
  return root && whole && root.contains(whole) ? whole : null;
}

// A card after a whole block is away from its text, and shows what it quotes.
export const sitsApartFromText = (range: Range) => wholeBlockAround(range) !== null;
