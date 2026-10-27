export interface TextAnchor {
  quote: string;
  startOffset: number;
  endOffset: number;
}

function textNodes(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

export function textOffsetOf(root: Node, container: Node, offset: number) {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(container, offset);
  return range.toString().length;
}

export function anchorOfRange(root: Node, range: Range): TextAnchor | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const selected = range.toString();
  const quote = selected.trim();
  if (!quote) return null;
  const startOffset =
    textOffsetOf(root, range.startContainer, range.startOffset) +
    selected.length -
    selected.trimStart().length;
  return { quote, startOffset, endOffset: startOffset + quote.length };
}

// A triple-click or a drag past the end of a message selects up to a node outside it.
export function clampToRoot(root: Node, range: Range) {
  const clamped = range.cloneRange();
  if (!root.contains(clamped.startContainer)) clamped.setStart(root, 0);
  if (!root.contains(clamped.endContainer)) clamped.setEnd(root, root.childNodes.length);
  return clamped;
}

export function rangeFromOffsets(root: Node, startOffset: number, endOffset: number) {
  const range = document.createRange();
  let position = 0;
  let startSet = false;
  for (const node of textNodes(root)) {
    const length = node.data.length;
    if (!startSet && startOffset <= position + length) {
      range.setStart(node, startOffset - position);
      startSet = true;
    }
    if (startSet && endOffset <= position + length) {
      range.setEnd(node, endOffset - position);
      return range;
    }
    position += length;
  }
  return null;
}

// The rendered text can differ from when the comment was made, so the stored offsets
// are only trusted when they still select the quote. Otherwise the quote is searched for.
export function locateAnchor(root: Node, anchor: TextAnchor) {
  const text = root.textContent ?? '';
  if (text.slice(anchor.startOffset, anchor.endOffset) === anchor.quote) {
    return rangeFromOffsets(root, anchor.startOffset, anchor.endOffset);
  }
  const found = text.indexOf(anchor.quote);
  return found === -1 ? null : rangeFromOffsets(root, found, found + anchor.quote.length);
}
