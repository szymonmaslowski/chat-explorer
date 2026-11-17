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
  // An upload's size keeps its room before it loads, so the text below does not move.
  const fileId = /^\/api\/files\/([^/?#]+)$/.exec(src)?.[1];
  const size = fileId ? (env as RenderEnv).imageSize?.(fileId) : null;
  if (size) {
    token.attrSet('width', String(size.width));
    token.attrSet('height', String(size.height));
  }
  return renderImage(tokens, index, options, env, self);
};

// Table alignment as a class, not markdown-it's style attribute, so the Content-Security-Policy
// needs no exception for inline styles.
for (const rule of ['th_open', 'td_open'] as const) {
  markdown.renderer.rules[rule] = (tokens, index, options, _env, self) => {
    const token = tokens[index]!;
    const align = /text-align:\s*(left|center|right)/.exec(String(token.attrGet('style') ?? ''));
    if (align) {
      token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'style');
      token.attrJoin('class', `align-${align[1]}`);
    }
    return self.renderToken(tokens, index, options);
  };
}

export type ImageSizeLookup = (fileId: string) => { width: number; height: number } | null;

interface RenderEnv {
  answeredPart?: AnsweredPartLookup;
  imageSize?: ImageSizeLookup;
}

export const renderMarkdown = (
  source: string,
  answeredPart?: AnsweredPartLookup,
  imageSize?: ImageSizeLookup,
) => markdown.render(source, { answeredPart, imageSize } satisfies RenderEnv);
