import { parseHTML } from 'linkedom';
import type { AnsweredPartLookup } from './answer-tags.js';
import { renderMarkdown } from './markdown.js';
import { speechBlocks } from './speech-blocks.js';

// The blocks the page finds in a rendered answer, found without a browser. With the lookup of
// what its tags name, the user's comments are blocks too, as on the page.
export function messageSpeechBlocks(markdown: string, answeredPart?: AnsweredPartLookup) {
  const { document } = parseHTML(
    `<!doctype html><html><body>${renderMarkdown(markdown, answeredPart)}</body></html>`,
  );
  return speechBlocks(document.body).map(({ block }) => block);
}
