// A small stroke font, so silkscreen text can be exported as real geometry.
//
// The editor stores a TEXT record with an empty `pathStr` and regenerates the
// glyph outlines itself, which means a board written by this tool carries the
// string but no strokes. Fabrication data needs the strokes, so this module
// draws them from a compact vector font defined here.
//
// Each glyph lives in a 4 x 6 box with the origin at the bottom left and y
// pointing up; the drawing code scales it to the requested text height and
// flips y for board coordinates.
const G = {
  '0': [[[0, 0], [0, 6], [4, 6], [4, 0], [0, 0]], [[0, 0], [4, 6]]],
  '1': [[[1, 5], [2, 6], [2, 0]], [[1, 0], [3, 0]]],
  '2': [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [0, 0], [4, 0]]],
  '3': [[[0, 6], [4, 6], [2, 4], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  '4': [[[3, 0], [3, 6], [0, 2], [4, 2]]],
  '5': [[[4, 6], [0, 6], [0, 3], [3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
  '6': [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]],
  '7': [[[0, 6], [4, 6], [1, 0]]],
  '8': [[[1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3]]],
  '9': [[[4, 3], [0, 3], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0], [0, 1]]],
  A: [[[0, 0], [0, 4], [2, 6], [4, 4], [4, 0]], [[0, 2], [4, 2]]],
  B: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
  C: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1]]],
  D: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 1], [3, 0], [0, 0]]],
  E: [[[4, 6], [0, 6], [0, 0], [4, 0]], [[0, 3], [3, 3]]],
  F: [[[4, 6], [0, 6], [0, 0]], [[0, 3], [3, 3]]],
  G: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 3], [2, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[1, 0], [3, 0]], [[2, 0], [2, 6]], [[1, 6], [3, 6]]],
  J: [[[4, 6], [4, 1], [3, 0], [1, 0], [0, 1]]],
  K: [[[0, 0], [0, 6]], [[4, 6], [0, 3], [4, 0]]],
  L: [[[0, 6], [0, 0], [4, 0]]],
  M: [[[0, 0], [0, 6], [2, 4], [4, 6], [4, 0]]],
  N: [[[0, 0], [0, 6], [4, 0], [4, 6]]],
  O: [[[1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0]]],
  P: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]]],
  Q: [[[1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0]], [[2, 2], [4, 0]]],
  R: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[2, 3], [4, 0]]],
  S: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 4], [1, 3], [3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  T: [[[0, 6], [4, 6]], [[2, 6], [2, 0]]],
  U: [[[0, 6], [0, 1], [1, 0], [3, 0], [4, 1], [4, 6]]],
  V: [[[0, 6], [2, 0], [4, 6]]],
  W: [[[0, 6], [1, 0], [2, 3], [3, 0], [4, 6]]],
  X: [[[0, 0], [4, 6]], [[0, 6], [4, 0]]],
  Y: [[[0, 6], [2, 3], [4, 6]], [[2, 3], [2, 0]]],
  Z: [[[0, 6], [4, 6], [0, 0], [4, 0]]],
  '+': [[[2, 1], [2, 5]], [[0, 3], [4, 3]]],
  '-': [[[0, 3], [4, 3]]],
  '_': [[[0, 0], [4, 0]]],
  '.': [[[2, 0], [2, 1]]],
  ',': [[[2, 1], [1, 0]]],
  ':': [[[2, 1], [2, 2]], [[2, 4], [2, 5]]],
  '/': [[[0, 0], [4, 6]]],
  '(': [[[3, 6], [1, 4], [1, 2], [3, 0]]],
  ')': [[[1, 6], [3, 4], [3, 2], [1, 0]]],
  '=': [[[0, 2], [4, 2]], [[0, 4], [4, 4]]],
  '~': [[[0, 4], [1, 5], [3, 3], [4, 4]]],
  ' ': [],
};

/** Glyph box, in font units. */
export const FONT_BOX = { width: 4, height: 6 };

/**
 * Turn a string into polylines in board units.
 *
 * @param {string} text
 * @param {{x: number, y: number, size?: number, rotation?: number, mirror?: boolean, anchor?: 'start'|'middle'|'end'}} opts
 *        size = glyph height in board units, x/y = anchor point, rotation in degrees
 * @returns {Array<Array<{x:number,y:number}>>}
 */
export function textStrokes(text, opts = {}) {
  const size = opts.size ?? 4;                    // units
  const rotation = ((opts.rotation ?? 0) * Math.PI) / 180;
  const mirror = opts.mirror === true || opts.mirror === '1';
  const advance = size * (FONT_BOX.width / FONT_BOX.height) * 1.35;
  const chars = [...String(text ?? '')];
  const totalWidth = chars.length * advance;
  let cursor = 0;
  if (opts.anchor === 'middle') cursor = -totalWidth / 2;
  else if (opts.anchor === 'end') cursor = -totalWidth;

  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const out = [];
  for (const ch of chars) {
    const glyph = G[ch] ?? G[ch.toUpperCase()] ?? null;
    if (glyph) {
      for (const stroke of glyph) {
        out.push(stroke.map(([gx, gy]) => {
          // font space -> board space (y flips: the font has y up, the board down)
          let lx = cursor + (gx / FONT_BOX.height) * size;
          const ly = -(gy / FONT_BOX.height) * size;
          if (mirror) lx = -lx;
          return { x: opts.x + lx * cos - ly * sin, y: opts.y + lx * sin + ly * cos };
        }));
      }
    }
    cursor += advance;
  }
  return out;
}

/** Width of a rendered string in board units (for layout decisions). */
export function textWidth(text, size = 4) {
  return [...String(text ?? '')].length * size * (FONT_BOX.width / FONT_BOX.height) * 1.35;
}
