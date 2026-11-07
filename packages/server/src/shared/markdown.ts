import MarkdownIt from 'markdown-it';
import { answerTags, type AnsweredPartLookup } from './answer-tags.js';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false }).use(answerTags);

export const renderMarkdown = (source: string, answeredPart?: AnsweredPartLookup) =>
  markdown.render(source, { answeredPart });
