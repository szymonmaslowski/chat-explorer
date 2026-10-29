import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@shared/markdown';
import { messageSpeechBlocks } from '@shared/message-speech-blocks';
import { speechBlocks } from '../src/lib/speech-blocks';

// The daemon renders answers ahead of time, so it must find the same blocks without a browser.
function blocksOf(markdown: string) {
  const root = document.createElement('div');
  root.innerHTML = renderMarkdown(markdown);
  const blocks = speechBlocks(root);
  expect(messageSpeechBlocks(markdown)).toEqual(blocks.map(({ block }) => block));
  return blocks.map(({ element, block }) => ({ tag: element.tagName, block }));
}

describe('speech blocks', () => {
  it('reads headings, paragraphs and quotes as text', () => {
    expect(blocksOf('## Caching\n\nUse an *ETag*.\n\n> Quoted\n> line')).toEqual([
      { tag: 'H2', block: { kind: 'text', text: 'Caching' } },
      { tag: 'P', block: { kind: 'text', text: 'Use an ETag.' } },
      { tag: 'BLOCKQUOTE', block: { kind: 'text', text: 'Quoted line' } },
    ]);
  });

  it('reads each list item on its own, nested items after their parent', () => {
    expect(blocksOf('- First\n  - Inner\n- Second\n\n1. Third')).toEqual([
      { tag: 'LI', block: { kind: 'text', text: 'First' } },
      { tag: 'LI', block: { kind: 'text', text: 'Inner' } },
      { tag: 'LI', block: { kind: 'text', text: 'Second' } },
      { tag: 'LI', block: { kind: 'text', text: 'Third' } },
    ]);
  });

  it('announces code with its language and line count', () => {
    expect(blocksOf('```ts\nconst a = 1;\nconst b = 2;\n```\n\n    indented')).toEqual([
      { tag: 'PRE', block: { kind: 'code', language: 'ts', lines: 2 } },
      { tag: 'PRE', block: { kind: 'code', language: '', lines: 1 } },
    ]);
  });

  it('treats mermaid and box drawings as diagrams', () => {
    expect(blocksOf('```mermaid\ngraph TD; A-->B\n```\n\n```\n┌───┐\n│ A │\n└───┘\n```')).toEqual([
      { tag: 'PRE', block: { kind: 'diagram' } },
      { tag: 'PRE', block: { kind: 'diagram' } },
    ]);
  });

  it('counts the columns and body rows of a table', () => {
    expect(blocksOf('| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |')).toEqual([
      { tag: 'TABLE', block: { kind: 'table', columns: 3, rows: 2 } },
    ]);
  });

  it('reads a bare address as its host name and an image as its description', () => {
    expect(
      blocksOf('See https://github.com/ggml-org/whisper.cpp now.\n\n![Fork map](map.png)'),
    ).toEqual([
      { tag: 'P', block: { kind: 'text', text: 'See github.com now.' } },
      { tag: 'P', block: { kind: 'image', description: 'Fork map' } },
    ]);
  });

  it('reads code inside a list item after the item', () => {
    expect(blocksOf('- Run this:\n\n  ```sh\n  pnpm build\n  ```')).toEqual([
      { tag: 'LI', block: { kind: 'text', text: 'Run this:' } },
      { tag: 'PRE', block: { kind: 'code', language: 'sh', lines: 1 } },
    ]);
  });
});
