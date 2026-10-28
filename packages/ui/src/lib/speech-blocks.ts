import type { SpeechBlock } from '@shared/types';

export interface SpokenElement {
  element: HTMLElement;
  block: SpeechBlock;
}

const readTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TABLE']);
const listTags = new Set(['UL', 'OL']);
const diagramLanguages = new Set(['mermaid', 'plantuml', 'dot', 'graphviz', 'd2', 'ascii']);
// Box-drawing characters (─│┌┐└┘├┤) make a plain code block an ASCII diagram.
const boxDrawing = /[─-╿]/g;
const minimumBoxDrawing = 3;
const urlText = /^(https?:\/\/|www\.)/;

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

// A link written out as an address is read as its host name instead of letter by letter.
function spokenText(element: HTMLElement) {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const removed of copy.querySelectorAll('ul, ol, pre, table')) removed.remove();
  for (const link of copy.querySelectorAll('a')) {
    if (urlText.test(link.textContent ?? '')) {
      try {
        link.textContent = new URL(link.href).hostname;
      } catch {}
    }
  }
  for (const image of copy.querySelectorAll('img')) image.replaceWith(image.alt);
  return collapse(copy.textContent ?? '');
}

function codeBlock(pre: HTMLElement): SpeechBlock {
  const code = pre.querySelector('code') ?? pre;
  const language = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1] ?? '';
  const source = code.textContent ?? '';
  if (
    diagramLanguages.has(language.toLowerCase()) ||
    (source.match(boxDrawing)?.length ?? 0) >= minimumBoxDrawing
  ) {
    return { kind: 'diagram' };
  }
  return { kind: 'code', language, lines: source.replace(/\n$/, '').split('\n').length };
}

function tableBlock(table: HTMLElement): SpeechBlock {
  const rows = [...table.querySelectorAll('tr')];
  const header = table.querySelector('thead') ? 1 : 0;
  return {
    kind: 'table',
    columns: rows[0]?.children.length ?? 0,
    rows: Math.max(0, rows.length - header),
  };
}

function describe(element: HTMLElement): SpeechBlock | null {
  if (element.tagName === 'PRE') return codeBlock(element);
  if (element.tagName === 'TABLE') return tableBlock(element);
  const image = element.querySelector('img');
  if (image && collapse(element.textContent ?? '') === '') {
    return { kind: 'image', description: image.alt };
  }
  const text = spokenText(element);
  return text ? { kind: 'text', text } : null;
}

function collectList(list: Element, into: SpokenElement[]) {
  for (const item of list.children) {
    if (item instanceof HTMLElement && item.tagName === 'LI') collectItem(item, into);
  }
}

function collect(container: Element, into: SpokenElement[]) {
  for (const child of container.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (listTags.has(child.tagName)) {
      collectList(child, into);
    } else if (readTags.has(child.tagName)) {
      const block = describe(child);
      if (block) into.push({ element: child, block });
    }
  }
}

// An item is read without its nested lists, code and tables, which follow it as blocks of their own.
function collectItem(item: HTMLElement, into: SpokenElement[]) {
  const text = spokenText(item);
  if (text) into.push({ element: item, block: { kind: 'text', text } });
  for (const child of item.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (listTags.has(child.tagName)) collectList(child, into);
    else if (child.tagName === 'PRE') into.push({ element: child, block: codeBlock(child) });
    else if (child.tagName === 'TABLE') into.push({ element: child, block: tableBlock(child) });
  }
}

export function speechBlocks(root: HTMLElement) {
  const blocks: SpokenElement[] = [];
  collect(root, blocks);
  return blocks;
}

// Nested blocks follow their ancestors, so the last block holding the target is the innermost.
export function blockIndexAt(blocks: SpokenElement[], target: Node) {
  return blocks.findLastIndex(({ element }) => element.contains(target));
}

// A list item's own text, without the nested lists, code and tables read after it.
export function blockTextRange(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  if (element.tagName === 'LI') {
    const nested = [...element.children].find(
      (child) =>
        listTags.has(child.tagName) || child.tagName === 'PRE' || child.tagName === 'TABLE',
    );
    if (nested) range.setEndBefore(nested);
  }
  return range;
}
