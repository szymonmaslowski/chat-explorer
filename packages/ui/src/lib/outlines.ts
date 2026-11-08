export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Span {
  id: string;
  messageId: string;
  startOffset: number;
  endOffset: number;
}

// A range's client rects come per inline element; rects that share most of their height are one
// line of text.
export function lineBoxes(rects: Box[]) {
  const lines: Box[] = [];
  const sorted = rects
    .filter((rect) => rect.right > rect.left && rect.bottom > rect.top)
    .sort((first, second) => first.top - second.top || first.left - second.left);
  for (const rect of sorted) {
    const line = lines.at(-1);
    const shared = line ? Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top) : 0;
    if (line && shared > (rect.bottom - rect.top) / 2) {
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
    } else {
      lines.push({ ...rect });
    }
  }
  return lines;
}

const overlapsHorizontally = (first: Box, second: Box) =>
  first.left < second.right && second.left < first.right;
// Lines further apart than a line's height, such as text on both sides of an opened comment, are
// not joined into one shape.
const adjacent = (first: Box, second: Box) =>
  second.top - first.bottom <= Math.max(first.bottom - first.top, second.bottom - second.top);

// One shape around consecutive lines: down the right edges, back up the left ones, meeting
// halfway between lines. Lines that do not overlap or are far apart start a new shape.
export function outlinePath(lines: Box[], outset: number) {
  const chains: Box[][] = [];
  for (const line of lines) {
    const chain = chains.at(-1);
    const previous = chain?.at(-1);
    if (chain && previous && overlapsHorizontally(previous, line) && adjacent(previous, line)) {
      chain.push(line);
    } else {
      chains.push([line]);
    }
  }
  return chains.map((chain) => chainPath(chain, outset)).join(' ');
}

function chainPath(chain: Box[], outset: number) {
  const tops = chain.map((line, index) =>
    index === 0 ? line.top - outset : (chain[index - 1]!.bottom + line.top) / 2,
  );
  const bottoms = chain.map((line, index) =>
    index === chain.length - 1 ? line.bottom + outset : (line.bottom + chain[index + 1]!.top) / 2,
  );
  const lefts = chain.map((line) => line.left - outset);
  const rights = chain.map((line) => line.right + outset);
  const round = (value: number) => Math.round(value * 10) / 10;
  const steps = [`M ${round(lefts[0]!)} ${round(tops[0]!)}`];
  chain.forEach((_, index) =>
    steps.push(`H ${round(rights[index]!)}`, `V ${round(bottoms[index]!)}`),
  );
  for (let index = chain.length - 1; index >= 0; index--) {
    steps.push(`H ${round(lefts[index]!)}`, `V ${round(tops[index]!)}`);
  }
  return `${steps.join(' ')} Z`;
}

// How many spans nest inside each span of the same message, so an outer outline can sit outside
// the inner ones. Spans with the same text nest in list order.
export function nestingLevels(spans: Span[]) {
  const length = (span: Span) => span.endOffset - span.startOffset;
  const sorted = [...spans].sort((first, second) => length(first) - length(second));
  const levels = new Map<string, number>();
  sorted.forEach((span, index) => {
    let level = 0;
    for (const inner of sorted.slice(0, index)) {
      const contained =
        inner.messageId === span.messageId &&
        inner.startOffset >= span.startOffset &&
        inner.endOffset <= span.endOffset;
      if (contained) level = Math.max(level, levels.get(inner.id)! + 1);
    }
    levels.set(span.id, level);
  });
  return levels;
}
