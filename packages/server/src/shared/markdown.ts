import MarkdownIt from 'markdown-it';
import { answerTags, type AnsweredPartLookup } from './answer-tags.js';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false }).use(answerTags);

// A long chat holds many screenshots; each loads only when it comes near the screen.
const renderImage = markdown.renderer.rules.image!;
markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  tokens[index]!.attrSet('loading', 'lazy');
  tokens[index]!.attrSet('decoding', 'async');
  return renderImage(tokens, index, options, env, self);
};

export const renderMarkdown = (source: string, answeredPart?: AnsweredPartLookup) =>
  markdown.render(source, { answeredPart });
