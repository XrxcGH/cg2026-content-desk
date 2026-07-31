/**
 * Minimal QR encoder: byte mode, error-correction level M, versions 1-3
 * (up to 42 characters: enough for any LAN URL this desk shows).
 *
 * Vendored rather than fetched: QR images from a web API would make venue
 * screens depend on venue internet, which this project treats as absent.
 * Follows the standard Model 2 construction (finders, timing, single
 * alignment pattern for v2+, zigzag placement, all eight masks scored by the
 * spec's penalty rules, precomputed ECC-M format words).
 */

const FORMAT_M = [0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0];
/** [total codewords, data codewords] per version at ECC M (single block). */
const CAPACITY = { 1: [26, 16], 2: [44, 28], 3: [70, 44] };

// ---- GF(256) arithmetic for Reed-Solomon --------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;

/**
 * Reed-Solomon remainder: the error-correction codewords.
 *
 * The two halves of this use opposite coefficient orders, which is worth
 * spelling out because getting it wrong produces a symbol that looks perfect
 * and cannot be scanned. The generator is built constant-term first, since
 * that is the natural direction for repeated multiplication by (x + a^i). The
 * division below walks the remainder highest-degree first. So the generator is
 * reversed once, here, rather than being silently consumed backwards.
 */
export function rsRemainder(data, ecLen) {
  // Generator polynomial of degree ecLen, ascending: gen[0] is the constant
  // term and gen[ecLen] is the monic leading 1.
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gfMul(gen[j], EXP[i]);
      next[j + 1] ^= gen[j];
    }
    gen = next;
  }
  // Descending, leading 1 dropped: what the division loop expects.
  const div = gen.slice(0, ecLen).reverse();

  const rem = new Array(ecLen).fill(0);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.shift(); rem.push(0);
    for (let j = 0; j < ecLen; j++) rem[j] ^= gfMul(div[j], factor);
  }
  return rem;
}

// ---- encoding ------------------------------------------------------------
function toCodewords(text, version) {
  const bytes = new TextEncoder().encode(text);
  const [total, dataLen] = CAPACITY[version];
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);              // byte mode
  push(bytes.length, 8);        // count (8 bits for versions 1-9)
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataLen * 8 - bits.length));   // terminator
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  }
  for (let pad = 0xEC; data.length < dataLen;) {
    data.push(pad);
    pad = pad === 0xEC ? 0x11 : 0xEC;
  }
  return data.concat(rsRemainder(data, total - dataLen));
}

// ---- matrix construction --------------------------------------------------
function buildMatrix(codewords, version) {
  const size = 17 + 4 * version;
  const grid = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, v) => { grid[y][x] = v; fixed[y][x] = true; };

  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

  for (let i = 8; i < size - 8; i++) {           // timing
    if (!fixed[6][i]) set(i, 6, i % 2 === 0);
    if (!fixed[i][6]) set(6, i, i % 2 === 0);
  }

  if (version >= 2) {                            // single alignment pattern
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(c + dx, c + dy, d !== 1);
    }
  }

  // Reserve format areas (values placed after masking).
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { fixed[i][8] = true; fixed[8][i] = true; }
    if (i < 8) { fixed[8][size - 1 - i] = true; fixed[size - 1 - i][8] = true; }
  }
  fixed[8][8] = true;
  set(8, size - 8, true);                        // dark module

  // Zigzag data placement.
  let bit = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y][x] && bit < totalBits) {
          grid[y][x] = ((codewords[bit >> 3] >> (7 - (bit & 7))) & 1) === 1;
          bit++;
        }
      }
    }
  }
  return { grid, fixed, size };
}

const MASK = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

function penalty(grid, size) {
  let score = 0;
  const runScore = line => {
    let s = 0, run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else { if (run >= 5) s += run - 2; run = 1; }
    }
    return s;
  };
  for (let y = 0; y < size; y++) score += runScore(grid[y]);
  for (let x = 0; x < size; x++) score += runScore(grid.map(r => r[x]));
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const v = grid[y][x];
    if (v === grid[y][x + 1] && v === grid[y + 1][x] && v === grid[y + 1][x + 1]) score += 3;
  }
  const FINDER = [1, 0, 1, 1, 1, 0, 1];
  const hasPattern = (line, i) => {
    const at = k => line[i + k] === (FINDER[k] === 1);
    const light = (a, b) => { for (let k = a; k < b; k++) { if (i + k < 0 || i + k >= line.length || line[i + k]) return false; } return true; };
    if (i + 7 > line.length) return false;
    let core = true;
    for (let k = 0; k < 7; k++) core = core && at(k);
    return core && (light(-4, 0) || light(7, 11));
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (hasPattern(grid[y], x)) score += 40;
    if (hasPattern(grid.map(r => r[x]), y)) score += 40;
  }
  const dark = grid.flat().filter(Boolean).length;
  score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
  return score;
}

function placeFormat(grid, size, mask) {
  const bits = FORMAT_M[mask];
  const b = i => ((bits >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) grid[i][8] = b(i);
  grid[7][8] = b(6); grid[8][8] = b(7); grid[8][7] = b(8);
  for (let i = 9; i <= 14; i++) grid[8][14 - i] = b(i);
  for (let i = 0; i <= 7; i++) grid[8][size - 1 - i] = b(i);
  for (let i = 8; i <= 14; i++) grid[size - 15 + i][8] = b(i);
  grid[size - 8][8] = true;
}

/** Boolean matrix for `text` (true = dark). Throws past 42 chars. */
export function qrMatrix(text) {
  const len = new TextEncoder().encode(text).length;
  const version = len <= 14 ? 1 : len <= 26 ? 2 : 3;
  if (len > 42) throw new Error(`QR: "${text.slice(0, 20)}..." is ${len} bytes; max 42`);

  const codewords = toCodewords(text, version);
  const { grid, fixed, size } = buildMatrix(codewords, version);

  let best = null, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    const masked = grid.map((row, y) => row.map((v, x) =>
      fixed[y][x] ? v : (MASK[m](x, y) ? !v : v)));
    placeFormat(masked, size, m);
    const s = penalty(masked, size);
    if (s < bestScore) { bestScore = s; best = masked; }
  }
  return best;
}

/**
 * Inline SVG string with a quiet zone, dark modules in `fg` on `bg`.
 * Scale with CSS width/height; shape-rendering keeps modules crisp.
 */
export function qrSvg(text, { fg = '#000', bg = '#FFF' } = {}) {
  const m = qrMatrix(text);
  const n = m.length, q = 3;                     // quiet zone modules
  let rects = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (m[y][x]) rects += `<rect x="${x + q}" y="${y + q}" width="1" height="1"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}"` +
    ` shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${bg}"/>` +
    `<g fill="${fg}">${rects}</g></svg>`;
}
