// Measurements shared by all three sheets in the supplied reference ZIP.
export const REFERENCE_LAYOUT = Object.freeze({
  marginTop: 14.8, marginLeft: 11, gapHorizontal: 5.9, gapVertical: 6.1,
});

export function gridPosition(col, row, width, height, left, top, gapX, gapY) {
  return { x: left + col * (width + gapX), y: top + row * (height + gapY) };
}
