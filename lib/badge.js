// 5x7 glyphs. Stremio only paints one rating icon (IMDb), so the MAL
// score has to be drawn onto the poster itself. Rects avoid system fonts.
const FONT = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '10001', '01110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  b: ['10000', '10000', '11110', '10001', '10001', '10001', '11110']
};

const SCALE = 3;

function advance(ch) {
  if (ch === '.' || ch === ' ') return 3 * SCALE;
  return 6 * SCALE;
}

function measure(text) {
  let width = 0;
  for (const ch of text) width += advance(ch);
  return width;
}

function glyphRects(text, originX, originY, color) {
  const rects = [];
  let x = originX;

  for (const ch of text) {
    const glyph = FONT[ch] || FONT[' '];
    if (ch !== ' ' && ch !== '.') {
      for (let row = 0; row < glyph.length; row++) {
        for (let col = 0; col < glyph[row].length; col++) {
          if (glyph[row][col] !== '1') continue;
          rects.push(
            `<rect x="${x + col * SCALE}" y="${originY + row * SCALE}" width="${SCALE}" height="${SCALE}" fill="${color}"/>`
          );
        }
      }
    } else if (ch === '.') {
      rects.push(
        `<rect x="${x}" y="${originY + 5 * SCALE}" width="${2 * SCALE}" height="${2 * SCALE}" fill="${color}"/>`
      );
    }
    x += advance(ch);
  }

  return rects.join('');
}

function pill(text, x, y, background, foreground) {
  const padX = 8;
  const padY = 6;
  const textWidth = measure(text);
  const width = textWidth + padX * 2;
  const height = 7 * SCALE + padY * 2;
  const body = [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="6" fill="${background}"/>`,
    glyphRects(text, x + padX, y + padY, foreground)
  ].join('');
  return { width, height, body };
}

function renderBadgeSvg(imdbRating, malScore) {
  const margin = 12;
  const gap = 6;
  const specs = [];

  if (imdbRating) specs.push({ text: `IMDb ${imdbRating}`, background: '#F5C518', foreground: '#111111' });
  specs.push({ text: `MAL ${malScore}`, background: '#2E51A2', foreground: '#FFFFFF' });

  let x = margin;
  const bodies = [];
  let rowWidth = 0;
  let rowHeight = 0;

  for (const spec of specs) {
    const drawn = pill(spec.text, x, margin, spec.background, spec.foreground);
    bodies.push(drawn.body);
    rowWidth = x + drawn.width;
    rowHeight = drawn.height;
    x += drawn.width + gap;
  }

  const width = rowWidth + margin;
  const height = rowHeight + margin * 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${bodies.join('')}</svg>`
  );
}

module.exports = {
  formatScore(score) {
    const value = Number(score);
    if (!Number.isFinite(value) || value <= 0) return null;
    if (value >= 10) return '10';
    return value.toFixed(2).replace(/0$/, '');
  },
  renderBadgeSvg
};
