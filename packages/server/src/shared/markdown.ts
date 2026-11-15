import MarkdownIt from 'markdown-it';
import { answerTags, type AnsweredPartLookup } from './answer-tags.js';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false }).use(answerTags);

// Not loaded lazily: an image above the screen that loads late grows the page there, and Safari,
// which does not anchor the scroll position, then jumps.
const renderImage = markdown.renderer.rules.image!;
const { escapeHtml } = markdown.utils;
const isRemote = (src: string) => /^(https?:)?\/\//i.test(src);

// A remote image would load on its own, so it shows as a link to open on purpose: its URL could
// carry chat text to another server. The Content-Security-Policy blocks it anyway.
markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  const src = String(token.attrGet('src') ?? '');
  if (isRemote(src)) {
    const host = URL.canParse(src, 'https://x') ? new URL(src, 'https://x').host : src;
    const alt = self.renderInlineAsText(token.children ?? [], options, env);
    const label = alt ? `Image from ${host}: ${alt}` : `Image from ${host}`;
    return `<a class="remote-image" href="${escapeHtml(src)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
  }
  token.attrSet('decoding', 'async');
  return renderImage(tokens, index, options, env, self);
};

export const renderMarkdown = (source: string, answeredPart?: AnsweredPartLookup) =>
  markdown.render(source, { answeredPart });
