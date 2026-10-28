import type { SpeechBlock } from '../shared/types.js';

type PhraseLanguage = 'en' | 'pl';
type Word = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;

interface Phrases {
  codeBlock: string;
  diagram: string;
  table: string;
  image: string;
  line: Word;
  column: Word;
  row: Word;
}

const phrasesByLanguage: Record<PhraseLanguage, Phrases> = {
  en: {
    codeBlock: 'Code block',
    diagram: 'Diagram',
    table: 'Table',
    image: 'Image',
    line: { one: 'line', other: 'lines' },
    column: { one: 'column', other: 'columns' },
    row: { one: 'row', other: 'rows' },
  },
  pl: {
    codeBlock: 'Blok kodu',
    diagram: 'Diagram',
    table: 'Tabela',
    image: 'Obraz',
    line: { one: 'linia', few: 'linie', many: 'linii', other: 'linii' },
    column: { one: 'kolumna', few: 'kolumny', many: 'kolumn', other: 'kolumny' },
    row: { one: 'wiersz', few: 'wiersze', many: 'wierszy', other: 'wiersza' },
  },
};

const codeLanguageNames: Record<string, string> = {
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JavaScript',
  json: 'JSON',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  py: 'Python',
  python: 'Python',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  yaml: 'YAML',
  yml: 'YAML',
  md: 'Markdown',
  markdown: 'Markdown',
  vue: 'Vue',
  rs: 'Rust',
  rust: 'Rust',
  go: 'Go',
};

const unnamedCodeLanguages = new Set(['', 'text', 'txt', 'plaintext', 'console', 'output']);

const isPhraseLanguage = (language: string | null): language is PhraseLanguage =>
  language !== null && Object.hasOwn(phrasesByLanguage, language);

function count(language: string, amount: number, word: Word) {
  const rule = new Intl.PluralRules(language).select(amount);
  return `${amount} ${word[rule] ?? word.other}`;
}

function codeLanguageName(language: string) {
  const normalised = language.toLowerCase();
  if (unnamedCodeLanguages.has(normalised)) return null;
  return codeLanguageNames[normalised] ?? language;
}

export function speechText(block: SpeechBlock, language: string | null) {
  const phraseLanguage = isPhraseLanguage(language) ? language : 'en';
  const phrases = phrasesByLanguage[phraseLanguage];
  switch (block.kind) {
    case 'text':
      return block.text;
    case 'code': {
      const name = codeLanguageName(block.language);
      const lines = count(phraseLanguage, block.lines, phrases.line);
      return `${[phrases.codeBlock, name, lines].filter(Boolean).join(', ')}.`;
    }
    case 'diagram':
      return `${phrases.diagram}.`;
    case 'table':
      return `${phrases.table}, ${count(phraseLanguage, block.columns, phrases.column)}, ${count(phraseLanguage, block.rows, phrases.row)}.`;
    case 'image':
      return block.description ? `${phrases.image}: ${block.description}` : `${phrases.image}.`;
  }
}
