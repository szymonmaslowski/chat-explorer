import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/shared/markdown.js';

describe('rendering markdown', () => {
  it('shows HTML in an answer as text, and drops script links', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> [a](javascript:alert(1))');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
  });

  it('turns a remote image into a link that names its host, so nothing loads on its own', () => {
    expect(renderMarkdown('![A chart](https://example.com/p.png?leak=secret)')).toBe(
      '<p><a class="remote-image" href="https://example.com/p.png?leak=secret" target="_blank" rel="noreferrer">Image from example.com: A chart</a></p>\n',
    );
    expect(renderMarkdown('![](//example.com/p.png)')).toContain('>Image from example.com</a>');
  });

  it('keeps an image from the app itself', () => {
    expect(renderMarkdown('![Upload](/api/files/abc)')).toBe(
      '<p><img src="/api/files/abc" alt="Upload" decoding="async"></p>\n',
    );
  });

  it("checks an answer card's link like any other link", () => {
    const html = renderMarkdown('[c:abcdefghij]\nHi', () => ({
      quote: '',
      text: 'Why?',
      href: 'javascript:alert(1)',
    }));
    expect(html).toContain('class="answer-card"');
    expect(html).not.toContain('answer-jump');
  });
});
