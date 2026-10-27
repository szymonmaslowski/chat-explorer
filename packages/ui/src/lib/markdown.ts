import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

export const renderMarkdown = (source: string) => markdown.render(source);
