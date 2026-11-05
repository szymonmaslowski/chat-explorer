export interface CardRequest {
  id: string;
  anchorTop: number;
  anchorLeft: number;
  width: number;
  height: number;
}

export interface CardPlacement {
  id: string;
  top: number;
  left: number;
  width: number;
}

const gap = 6;
export const draftCardWidth = 280;
export const submittedCardWidth = 220;
const railGap = 24;
// The room the page keeps on the right of the text for the cards.
export const commentRailWidth = railGap + draftCardWidth;
export const railLeftOf = (textWidth: number) => textWidth + railGap;

// Each card sits in the rail beside the text, level with the first line of its anchor. A card
// that would overlap the one above moves down below it, so the cards keep the reading order.
export function layoutCards(requests: CardRequest[], railLeft: number): CardPlacement[] {
  const ordered = [...requests].sort(
    (first, second) => first.anchorTop - second.anchorTop || first.anchorLeft - second.anchorLeft,
  );
  let freeTop = -Infinity;
  return ordered.map((request) => {
    const top = Math.max(request.anchorTop, freeTop);
    freeTop = top + request.height + gap;
    return { id: request.id, top, left: railLeft, width: request.width };
  });
}
