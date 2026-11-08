import { insertedAttribute } from '@shared/speech-blocks';
import { blockTextRange } from './speech-blocks';

export interface ClipboardText {
  plain: string;
  // Kept by editors that paste formatting (mail, documents, chat apps).
  html?: string;
}

export async function copyToClipboard({ plain, html }: ClipboardText) {
  if (html && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return;
    } catch {}
  }
  await navigator.clipboard.writeText(plain);
}

// Code as it is written, a table as tab-separated rows (cells when pasted into a spreadsheet),
// and other blocks without the nested lists, code and tables that follow them.
export function blockClipboardText(element: HTMLElement): ClipboardText {
  if (element.tagName === 'PRE') return { plain: element.textContent ?? '' };
  if (element.tagName === 'TABLE') {
    const rows = [...element.querySelectorAll('tr')].map((row) =>
      [...row.children].map((cell) => (cell.textContent ?? '').trim()).join('\t'),
    );
    return { plain: rows.join('\n'), html: element.outerHTML };
  }
  const html = document.createElement('div');
  html.append(blockTextRange(element).cloneContents());
  for (const inserted of html.querySelectorAll(`[${insertedAttribute}]`)) inserted.remove();
  return { plain: (html.textContent ?? '').trim(), html: html.innerHTML };
}
