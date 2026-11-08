import { insertedAttribute } from '@shared/speech-blocks';

export interface TextAnchor {
  quote: string;
  startOffset: number;
  endOffset: number;
}

function textNodes(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, (node) =>
    node.parentElement?.closest(`[${insertedAttribute}]`)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT,
  );
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

const textOf = (root: Node) =>
  textNodes(root)
    .map((node) => node.data)
    .join('');

export function textOffsetOf(root: Node, container: Node, offset: number) {
  const boundary = document.createRange();
  boundary.setStart(container, offset);
  let position = 0;
  for (const node of textNodes(root)) {
    if (node === container) return position + offset;
    if (boundary.comparePoint(node, 0) >= 0) break;
    position += node.data.length;
  }
  return position;
}

export function anchorOfRange(root: Node, range: Range): TextAnchor | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = textOffsetOf(root, range.startContainer, range.startOffset);
  const selected = textOf(root).slice(
    start,
    textOffsetOf(root, range.endContainer, range.endOffset),
  );
  const quote = selected.trim();
  if (!quote) return null;
  const startOffset = start + selected.length - selected.trimStart().length;
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

// A general comment quotes nothing, so it sits at the end of the message's last line of text.
function endOfText(root: Node) {
  const range = document.createRange();
  const lastText = textNodes(root).findLast((node) => node.data.trim() !== '');
  if (lastText) range.setStart(lastText, lastText.data.length);
  else range.setStart(root, root.childNodes.length);
  return range;
}

// The rendered text can differ from when the comment was made, so the stored offsets
// are only trusted when they still select the quote. Otherwise the quote is searched for.
export function locateAnchor(root: Node, anchor: TextAnchor) {
  if (!anchor.quote) return endOfText(root);
  const text = textOf(root);
  if (text.slice(anchor.startOffset, anchor.endOffset) === anchor.quote) {
    return rangeFromOffsets(root, anchor.startOffset, anchor.endOffset);
  }
  const found = text.indexOf(anchor.quote);
  return found === -1 ? null : rangeFromOffsets(root, found, found + anchor.quote.length);
}
