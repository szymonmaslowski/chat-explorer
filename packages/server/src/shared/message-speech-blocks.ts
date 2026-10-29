import { parseHTML } from 'linkedom';
import { renderMarkdown } from './markdown.js';
import { speechBlocks } from './speech-blocks.js';

// The blocks the page finds in a rendered answer, found without a browser.
export function messageSpeechBlocks(markdown: string) {
  const { document } = parseHTML(
    `<!doctype html><html><body>${renderMarkdown(markdown)}</body></html>`,
  );
  return speechBlocks(document.body).map(({ block }) => block);
}
