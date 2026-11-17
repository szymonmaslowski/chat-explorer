// The widths a reader dragged the desktop columns to, as shares of the page's width, kept per chat
// on this device. A column without one keeps its default width.
export interface ColumnWidths {
  chats: number | null;
  map: number | null;
}

export type ResizableColumn = keyof ColumnWidths;

export const defaultColumnWidths: ColumnWidths = { chats: null, map: null };

const storageKey = (explorationId: string) => `chat-explorer.column-widths.${explorationId}`;

const share = (value: unknown) =>
  typeof value === 'number' && value > 0 && value < 1 ? value : null;

export function readColumnWidths(explorationId: string): ColumnWidths {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey(explorationId)) ?? 'null');
    return { chats: share(stored?.chats), map: share(stored?.map) };
  } catch {
    return defaultColumnWidths;
  }
}

export function storeColumnWidths(explorationId: string, widths: ColumnWidths) {
  try {
    if (widths.chats === null && widths.map === null) {
      localStorage.removeItem(storageKey(explorationId));
    } else {
      localStorage.setItem(storageKey(explorationId), JSON.stringify(widths));
    }
  } catch {}
}
