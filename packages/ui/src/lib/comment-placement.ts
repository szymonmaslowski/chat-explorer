import { insertedAttribute } from '@shared/speech-blocks';

export const placeEndAttribute = 'data-place-end';

// The cell of a table a quote ends in, if the table is inside the message.
export function tableCellAt(range: Range) {
  const end = range.endContainer;
  const element = end instanceof Element ? end : end.parentElement;
  const root = element?.closest('[data-anchor-root]');
  const cell = element?.closest<HTMLTableCellElement>('td, th');
  return root && cell && root.contains(cell) ? cell : null;
}

// A card cannot sit inside a code block or a table, so the comments on text in one open after it
// as a whole. Returns that block, or null when the card can sit right after its text.
export function wholeBlockAround(range: Range) {
  const end = range.endContainer;
  const element = end instanceof Element ? end : end.parentElement;
  const root = element?.closest('[data-anchor-root]');
  const whole = element?.closest('pre, table');
  return root && whole && root.contains(whole) ? whole : null;
}

// A card cannot sit inside a code block, so the comments on text in one open after it as a
// whole. Such a card is away from its text, and shows what it quotes. A card on a table cell
// opens in a row of its own right under the cell's row, so it needs no quote.
export const sitsApartFromText = (range: Range) =>
  wholeBlockAround(range) !== null && !tableCellAt(range);

// Puts the mount in a row of its own, with one cell across all the columns, after the row of the
// quoted cell. A header cell's card goes to the top of the body, since the header holds no
// other rows. Cards of one place keep the order of their quotes.
export function insertInTableRow(
  cell: HTMLTableCellElement,
  mount: HTMLElement,
  endOffset: number,
) {
  const quotedRow = cell.parentElement as HTMLTableRowElement;
  const columns = [...quotedRow.cells].reduce((sum, each) => sum + each.colSpan, 0);
  const row = document.createElement('tr');
  row.setAttribute(insertedAttribute, '');
  row.setAttribute(placeEndAttribute, String(endOffset));
  row.className = 'comment-row';
  const rowCell = document.createElement('td');
  rowCell.colSpan = columns;
  rowCell.append(mount);
  row.append(rowCell);
  const table = quotedRow.closest('table')!;
  const section = quotedRow.parentElement!;
  const inHeader = section.tagName === 'THEAD';
  const body = inHeader
    ? (table.tBodies[0] ?? table.appendChild(document.createElement('tbody')))
    : section;
  let previous: Element | null = inHeader ? null : quotedRow;
  for (
    let next = previous ? previous.nextElementSibling : body.firstElementChild;
    next?.hasAttribute(placeEndAttribute) &&
    Number(next.getAttribute(placeEndAttribute)) <= endOffset;
    next = next.nextElementSibling
  ) {
    previous = next;
  }
  if (previous) previous.after(row);
  else body.prepend(row);
}

// Takes a place's mount out, with the row it sits in.
export function removeMount(mount: HTMLElement) {
  const row = mount.closest('tr.comment-row');
  mount.remove();
  row?.remove();
}

// A card in a table is as wide as the visible table and stays in view when a wide table scrolls.
export function fitToTable(mount: HTMLElement) {
  const table = mount.closest('table');
  if (!table) return false;
  mount.style.marginLeft = '';
  mount.style.width = `${table.clientWidth}px`;
  mount.style.position = 'sticky';
  mount.style.left = '0';
  return true;
}
