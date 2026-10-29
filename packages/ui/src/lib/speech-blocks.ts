import { listTags, speechBlocks as sharedSpeechBlocks } from '@shared/speech-blocks';
import type { SpeechBlock } from '@shared/types';

export interface SpokenElement {
  element: HTMLElement;
  block: SpeechBlock;
}

// Every element of a rendered answer is an HTML element.
export const speechBlocks = (root: HTMLElement) => sharedSpeechBlocks(root) as SpokenElement[];

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
