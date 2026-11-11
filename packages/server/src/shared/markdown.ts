import MarkdownIt from 'markdown-it';
import { answerTags, type AnsweredPartLookup } from './answer-tags.js';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false }).use(answerTags);

// Not loaded lazily: an image above the screen that loads late grows the page there, and Safari,
// which does not anchor the scroll position, then jumps.
const renderImage = markdown.renderer.rules.image!;
markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  tokens[index]!.attrSet('decoding', 'async');
  return renderImage(tokens, index, options, env, self);
};

export const renderMarkdown = (source: string, answeredPart?: AnsweredPartLookup) =>
  markdown.render(source, { answeredPart });
