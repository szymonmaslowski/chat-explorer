import type { MarkdownIt, StateBlock } from 'markdown-it';

// Claude starts each part of an answer with tags, alone on a line, naming what the part answers:
// one of the user's comments, or the text of a user message. The page shows each tag as a card
// of what was asked. The cards hold no text of their own, only attributes the stylesheet shows,
// so the answer's text, and the comment offsets into it, are the same with or without them. A
// card of a comment that quotes text has a button to that comment.

export const commentTag = (commentId: string) => `[c:${commentId}]`;
export const messageTag = (messageId: string) => `[m:${messageId}]`;

const tag = /\[([cm]):([0-9a-z]{10})\]/g;
const tagLine = /^[ \t]*(?:\[[cm]:[0-9a-z]{10}\][ \t]*)+$/;

export interface AnsweredPart {
  quote: string;
  text: string;
  href: string | null;
}

export type AnsweredPartLookup = (kind: 'comment' | 'message', id: string) => AnsweredPart | null;

declare module 'markdown-it' {
  interface Env {
    answeredPart?: AnsweredPartLookup;
  }
}

export const withoutTagLines = (markdown: string) =>
  markdown
    .split('\n')
    .filter((line) => !tagLine.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

function tagLineRule(state: StateBlock, startLine: number, _endLine: number, silent: boolean) {
  const lineStart = state.bMarks[startLine]! + state.tShift[startLine]!;
  const line = state.src.slice(lineStart, state.eMarks[startLine]);
  if (state.sCount[startLine]! - state.blkIndent >= 4 || !tagLine.test(line)) return false;
  if (silent) return true;
  const token = state.push('answer_tags', 'div', 0);
  token.content = line;
  token.map = [startLine, startLine + 1];
  state.line = startLine + 1;
  return true;
}

export function answerTags(markdown: MarkdownIt) {
  const { escapeHtml } = markdown.utils;
  const attribute = (name: string, value: string) => ` ${name}="${escapeHtml(value)}"`;

  function card(written: string, kind: string, id: string, part: AnsweredPart | null) {
    if (!part) return `<span class="answer-card unknown"${attribute('data-tag', written)}></span>`;
    const comment = kind === 'c' ? attribute('data-comment-id', id) : '';
    const quote = part.quote ? attribute('data-quote', part.quote) : '';
    const text = attribute('data-text', part.text);
    const jump = part.href
      ? `<a class="answer-jump"${attribute('href', part.href)}${attribute('title', 'Show the comment')}${attribute('aria-label', 'Show the comment')}></a>`
      : '';
    return `<span class="answer-card"${comment}${quote}${text}>${jump}</span>`;
  }

  markdown.block.ruler.before('paragraph', 'answer_tags', tagLineRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  markdown.renderer.rules.answer_tags = (tokens, index, _options, environment) => {
    const cards = [...tokens[index]!.content.matchAll(tag)].map(([written, kind, id]) =>
      card(
        written,
        kind!,
        id!,
        environment?.answeredPart?.(kind === 'c' ? 'comment' : 'message', id!) ?? null,
      ),
    );
    return `<div class="answer-tags">${cards.join('')}</div>\n`;
  };
}
