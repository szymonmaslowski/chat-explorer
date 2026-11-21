import type { BoardColumn, Fork } from '@shared/types';

export const mapViews = ['board', 'graph'] as const;
export type MapView = (typeof mapViews)[number];

const viewKey = (explorationId: string) => `chat-explorer.map-view.${explorationId}`;
const archivedKey = (explorationId: string) => `chat-explorer.map-archived.${explorationId}`;

// Which view of the forks this device shows for a chat: the graph or the board.
export function readMapView(explorationId: string): MapView {
  try {
    const stored = localStorage.getItem(viewKey(explorationId));
    return mapViews.find((view) => view === stored) ?? 'board';
  } catch {
    return 'board';
  }
}

export function storeMapView(explorationId: string, view: MapView) {
  try {
    localStorage.setItem(viewKey(explorationId), view);
  } catch {}
}

// Whether this device shows the archived forks of a chat, and only those, in either view.
export function readArchivedOnly(explorationId: string) {
  try {
    return localStorage.getItem(archivedKey(explorationId)) === 'true';
  } catch {
    return false;
  }
}

export function storeArchivedOnly(explorationId: string, shown: boolean) {
  try {
    if (shown) localStorage.setItem(archivedKey(explorationId), 'true');
    else localStorage.removeItem(archivedKey(explorationId));
  } catch {}
}

// What the graph shows when only archived forks are wanted: those forks, plus every fork above
// them, so each archived fork still hangs from its parent.
export function withAncestors(forks: Map<string, Fork>, ids: Set<string>) {
  const shown = new Set(ids);
  for (const id of ids) {
    let parentId = forks.get(id)?.parentForkId ?? null;
    while (parentId !== null && !shown.has(parentId)) {
      shown.add(parentId);
      parentId = forks.get(parentId)?.parentForkId ?? null;
    }
  }
  return shown;
}

export interface BoardColumnView {
  column: BoardColumn;
  forks: Fork[];
}

export interface BoardLayout {
  // Null while the chat has no main fork to show.
  main: Fork | null;
  columns: BoardColumnView[];
  ungrouped: Fork[];
}

const byPlace = (a: Fork, b: Fork) =>
  a.boardPosition - b.boardPosition || a.createdAt - b.createdAt;

// The board: the main fork on top, the columns left to right with their forks from the top
// down, and under them the forks with no column. With `archivedOnly`, only archived forks show,
// in the columns that hold one. Archiving never changes a fork's column or place.
export function boardLayout(
  forks: Iterable<Fork>,
  columns: BoardColumn[],
  archivedIds: Set<string>,
  archivedOnly: boolean,
): BoardLayout {
  const all = [...forks];
  const shown = all.filter(
    (fork) => fork.parentForkId !== null && archivedIds.has(fork.id) === archivedOnly,
  );
  const known = new Set(columns.map((column) => column.id));
  const inColumn = (id: string | null) =>
    shown
      .filter(
        (fork) =>
          (fork.boardColumnId !== null && known.has(fork.boardColumnId)
            ? fork.boardColumnId
            : null) === id,
      )
      .sort(byPlace);
  const views = columns.map((column) => ({ column, forks: inColumn(column.id) }));
  return {
    main: all.find((fork) => fork.parentForkId === null) ?? null,
    columns: archivedOnly ? views.filter((view) => view.forks.length > 0) : views,
    ungrouped: inColumn(null),
  };
}

// Where a card dropped at `index` among the shown cards of a column goes, as the fork to put it
// after (null: first). Forks the board does not show, archived ones, are skipped: the anchor is
// always a shown fork, so hidden forks keep their relative place.
export function dropAnchor(shownIds: string[], movedId: string, index: number) {
  const others = shownIds.filter((id) => id !== movedId);
  const at = Math.max(0, Math.min(index, others.length));
  return at === 0 ? null : others[at - 1]!;
}
