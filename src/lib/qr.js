/**
 * QR code encoder (ISO/IEC 18004), byte mode, versions 1 to 10.
 * Enough for any badge link, without adding a dependency to the toolkit.
 */

const EC_LEVELS = { L: 1, M: 0, Q: 3, H: 2 }; // format-information bits

// Per version, per level: [EC codewords per block, [blocks, data codewords per block], ...]
const BLOCKS = {
  1: { L: [7, [1, 19]], M: [10, [1, 16]], Q: [13, [1, 13]], H: [17, [1, 9]] },
  2: { L: [10, [1, 34]], M: [16, [1, 28]], Q: [22, [1, 22]], H: [28, [1, 16]] },
  3: { L: [15, [1, 55]], M: [26, [1, 44]], Q: [18, [2, 17]], H: [22, [2, 13]] },
  4: { L: [20, [1, 80]], M: [18, [2, 32]], Q: [26, [2, 24]], H: [16, [4, 9]] },
  5: { L: [26, [1, 108]], M: [24, [2, 43]], Q: [18, [2, 15], [2, 16]], H: [22, [2, 11], [2, 12]] },
  6: { L: [18, [2, 68]], M: [16, [4, 27]], Q: [24, [4, 19]], H: [28, [4, 15]] },
  7: { L: [20, [2, 78]], M: [18, [4, 31]], Q: [18, [2, 14], [4, 15]], H: [26, [4, 13], [1, 14]] },
  8: { L: [24, [2, 97]], M: [22, [2, 38], [2, 39]], Q: [22, [4, 18], [2, 19]], H: [26, [4, 14], [2, 15]] },
  9: { L: [30, [2, 116]], M: [22, [3, 36], [2, 37]], Q: [20, [4, 16], [4, 17]], H: [24, [4, 12], [4, 13]] },
  10: { L: [18, [2, 68], [2, 69]], M: [26, [4, 43], [1, 44]], Q: [24, [6, 19], [2, 20]], H: [28, [6, 15], [2, 16]] },
};

const ALIGNMENT = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

export const MAX_VERSION = 10;

function dataCodewords(version, level) {
  const [, ...groups] = BLOCKS[version][level];
  return groups.reduce((n, [count, size]) => n + count * size, 0);
}

// --- Reed-Solomon over GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1 ---

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsGenerator(degree) {
  const poly = new Array(degree).fill(0);
  poly[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      poly[j] = gfMultiply(poly[j], root);
      if (j + 1 < degree) poly[j] ^= poly[j + 1];
    }
    root = gfMultiply(root, 2);
  }
  return poly;
}

function rsRemainder(data, generator) {
  const rem = new Array(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    generator.forEach((coef, i) => { rem[i] ^= gfMultiply(coef, factor); });
  }
  return rem;
}

// --- Data encoding ---

function encodeData(bytes, version, level) {
  const capacityBits = dataCodewords(version, level) * 8;
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; codewords.length < capacityBits / 8; pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

/** Splits data into blocks, adds error correction and interleaves, as the standard requires. */
function addErrorCorrection(data, version, level) {
  const [ecLength, ...groups] = BLOCKS[version][level];
  const generator = rsGenerator(ecLength);
  const blocks = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, generator) });
    }
  }
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecLength; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// --- Matrix ---

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  set(row, col, dark) {
    this.dark[row][col] = dark;
    this.reserved[row][col] = true;
  }
}

function drawFunctionPatterns(m) {
  const { size, version } = m;
  // Finder patterns with their light separators
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = r0 + r;
        const col = c0 + c;
        if (row < 0 || col < 0 || row >= size || col >= size) continue;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        m.set(row, col, ring !== 2 && ring !== 4);
      }
    }
  }
  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    m.set(6, i, i % 2 === 0);
    m.set(i, 6, i % 2 === 0);
  }
  // Alignment patterns, except the three corners taken by finders.
  // From version 7 some sit on the timing lines, which is intended.
  const centres = ALIGNMENT[version];
  const last = centres.length - 1;
  centres.forEach((r, i) => {
    centres.forEach((c, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) m.set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    });
  });
  // Reserve format areas now; the bits are written after masking
  drawFormat(m, null, 0);
  m.set(size - 8, 8, true); // dark module
  drawVersion(m);
}

function formatBits(level, mask) {
  const data = (EC_LEVELS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** Writes the 15 format bits twice; with level null it only reserves the modules. */
function drawFormat(m, level, mask) {
  const size = m.size;
  const bits = level == null ? 0 : formatBits(level, mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  // Around the top-left finder
  for (let i = 0; i <= 5; i++) m.set(i, 8, bit(i));
  m.set(7, 8, bit(6));
  m.set(8, 8, bit(7));
  m.set(8, 7, bit(8));
  for (let i = 9; i < 15; i++) m.set(8, 14 - i, bit(i));
  // Split between the other two finders
  for (let i = 0; i < 8; i++) m.set(8, size - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) m.set(size - 15 + i, 8, bit(i));
  m.set(size - 8, 8, true);
}

function drawVersion(m) {
  const { version, size } = m;
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m.set(b, a, dark);
    m.set(a, b, dark);
  }
}

function drawCodewords(m, codewords) {
  const { size } = m;
  let i = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing pattern
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < size; v++) {
      const row = upward ? size - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        if (m.reserved[row][col]) continue;
        if (i < total) {
          m.dark[row][col] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m, mask) {
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (!m.reserved[r][c] && MASKS[mask](r, c)) m.dark[r][c] = !m.dark[r][c];
    }
  }
}

/** Penalty rules N1 to N4 from the standard; the lowest score picks the mask. */
export function penalty(dark) {
  const size = dark.length;
  let score = 0;
  const line = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b <= size; b++) {
        if (b < size && get(a, b) === get(a, b - 1)) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // 1:1:3:1:1 finder-like pattern with four light modules on one side
      for (let b = 0; b + 11 <= size; b++) {
        const s = Array.from({ length: 11 }, (_, k) => (get(a, b + k) ? 1 : 0)).join('');
        if (s === '10111010000' || s === '00001011101') score += 40;
      }
    }
  };
  line((r, c) => dark[r][c]);
  line((c, r) => dark[r][c]);
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const d = dark[r][c];
      if (d === dark[r][c + 1] && d === dark[r + 1][c] && d === dark[r + 1][c + 1]) score += 3;
    }
  }
  const darkCount = dark.flat().filter(Boolean).length;
  score += Math.floor(Math.abs((darkCount * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/**
 * Encodes text as a QR code.
 * @param {string} text
 * @param {{ level?: 'L'|'M'|'Q'|'H', version?: number, mask?: number }} [options]
 * @returns {{ version: number, level: string, mask: number, size: number, modules: boolean[][] }}
 */
export function encodeQr(text, { level = 'M', version, mask } = {}) {
  if (!(level in EC_LEVELS)) throw new Error(`Unknown error correction level "${level}"`);
  const bytes = [...new TextEncoder().encode(text)];
  const fits = (v) => 4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v, level) * 8;
  let v = version;
  if (v === undefined) {
    v = 1;
    while (v <= MAX_VERSION && !fits(v)) v++;
  }
  if (v > MAX_VERSION || !fits(v)) throw new Error(`Text too long for a version ${MAX_VERSION} QR code at level ${level} (${bytes.length} bytes)`);

  const codewords = addErrorCorrection(encodeData(bytes, v, level), v, level);
  const base = new Matrix(v);
  drawFunctionPatterns(base);
  drawCodewords(base, codewords);

  const build = (k) => {
    const m = new Matrix(v);
    m.dark = base.dark.map((row) => [...row]);
    m.reserved = base.reserved;
    applyMask(m, k);
    drawFormat(m, level, k);
    return m;
  };

  let best;
  for (const k of mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask]) {
    const m = build(k);
    const score = penalty(m.dark);
    if (!best || score < best.score) best = { m, score, k };
  }
  return { version: v, level, mask: best.k, size: best.m.size, modules: best.m.dark };
}

/**
 * Renders a QR code as SVG path data in module units, merging horizontal runs.
 * Draw it inside a viewBox of (size + 2 * quiet) square.
 */
export function qrPath({ modules, size }, quiet = 4) {
  const parts = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue;
      let end = c;
      while (end + 1 < size && modules[r][end + 1]) end++;
      parts.push(`M${c + quiet} ${r + quiet}h${end - c + 1}v1h-${end - c + 1}z`);
      c = end;
    }
  }
  return parts.join('');
}

/** A complete standalone SVG: dark modules on a light square with a quiet zone. */
export function qrSvg(text, { dark = '#05414D', light = '#FFFFFF', level = 'M', title } = {}) {
  const qr = encodeQr(text, { level });
  const n = qr.size + 8;
  const label = title ?? `QR code for ${text}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${escapeAttr(label)}">`
    + `<rect width="${n}" height="${n}" fill="${light}"/><path fill="${dark}" d="${qrPath(qr)}"/></svg>`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
