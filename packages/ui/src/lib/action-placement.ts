// Keeps the buttons clear of the selection handles on touch screens.
export const touchButtonOffset = 24;
// A round icon button and the gap after it; the height matches the button's.
export const actionButtonWidth = { mouse: 38, touch: 50 };
export const actionButtonHeight = { mouse: 32, touch: 44 };

// Under the last line of the range, starting where that line ends, kept inside the box.
export function placeUnderRange(
  range: Range,
  box: DOMRect,
  input: { buttonCount: number; coarse: boolean; clearHandles: boolean },
) {
  const rects = range.getClientRects();
  const lastLine = rects[rects.length - 1] ?? range.getBoundingClientRect();
  const width =
    input.buttonCount * (input.coarse ? actionButtonWidth.touch : actionButtonWidth.mouse);
  return {
    top:
      lastLine.bottom - box.top + 4 + (input.clearHandles && input.coarse ? touchButtonOffset : 0),
    left: Math.max(0, Math.min(lastLine.right - box.left + 6, box.width - width)),
  };
}
