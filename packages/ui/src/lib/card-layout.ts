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

// Each card sits just above the first line of its anchor. A card that would overlap one
// already placed moves above it, so cards on the same line stack upwards.
export function layoutCards(requests: CardRequest[], layerWidth: number): CardPlacement[] {
  const ordered = [...requests].sort(
    (first, second) => first.anchorTop - second.anchorTop || first.anchorLeft - second.anchorLeft,
  );
  const placed: (CardPlacement & { height: number })[] = [];
  for (const request of ordered) {
    const left = Math.max(0, Math.min(request.anchorLeft, layerWidth - request.width));
    let top = request.anchorTop - gap - request.height;
    let blocker = findOverlap(placed, left, top, request);
    while (blocker) {
      top = blocker.top - gap - request.height;
      blocker = findOverlap(placed, left, top, request);
    }
    placed.push({ id: request.id, top, left, width: request.width, height: request.height });
  }
  return placed.map(({ id, top, left, width }) => ({ id, top, left, width }));
}

function findOverlap(
  placed: (CardPlacement & { height: number })[],
  left: number,
  top: number,
  request: CardRequest,
) {
  return placed.find(
    (card) =>
      card.left < left + request.width &&
      left < card.left + card.width &&
      card.top < top + request.height + gap &&
      top < card.top + card.height + gap,
  );
}
