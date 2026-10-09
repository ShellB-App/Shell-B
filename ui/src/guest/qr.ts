// A small QR Code encoder (ISO/IEC 18004: byte mode, error correction level M), so the two-step setup can show its
// otpauth:// link as a code to scan without a library or a network request. It follows the reference algorithm
// published by Project Nayuki (MIT): data and padding, Reed-Solomon blocks, function patterns, zigzag placement and
// the mask with the lowest penalty.

const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26,
  28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMAT_M = 0;  // level M's two format bits
const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
const FINDER_LIKE = [[1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]];

const bit = (v: number, i: number) => ((v >>> i) & 1) !== 0;

function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

const dataCodewords = (ver: number) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 2);
  }
  return out;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (out.shift() as number);
    out.push(0);
    divisor.forEach((coef, i) => { out[i] ^= gfMul(coef, factor); });
  }
  return out;
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** The codewords for `data`: version picked to fit, padded, split into blocks with error correction, interleaved. */
function codewords(data: number[]): { ver: number; words: number[] } {
  let ver = 1;
  while (ver <= 40 && 4 + (ver <= 9 ? 8 : 16) + data.length * 8 > dataCodewords(ver) * 8) ver++;
  if (ver > 40) throw new Error('Too much text for a QR code');
  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4);  // byte mode
  put(data.length, ver <= 9 ? 8 : 16);
  data.forEach(b => put(b, 8));
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  const count = BLOCKS[ver], ecc = ECC_PER_BLOCK[ver], raw = Math.floor(rawModules(ver) / 8);
  const short = count - (raw % count), shortLen = Math.floor(raw / count), div = rsDivisor(ecc);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < count; i++) {
    const dat = bytes.slice(k, k + shortLen - ecc + (i < short ? 0 : 1));
    k += dat.length;
    const tail = rsRemainder(dat, div);
    if (i < short) dat.push(0);  // a placeholder, skipped when interleaving
    blocks.push(dat.concat(tail));
  }
  const words: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => { if (i !== shortLen - ecc || j >= short) words.push(b[i]); });
  }
  return { ver, words };
}

function penalty(m: boolean[][]): number {
  const size = m.length;
  let p = 0;
  const lines = [...m, ...m.map((_, x) => m.map(row => row[x]))];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else { if (run >= 5) p += run - 2; run = 1; }
    }
    for (let i = 0; i + 11 <= size; i++) {
      if (FINDER_LIKE.some(pat => pat.every((v, k) => Number(line[i + k]) === v))) p += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
  }
  const dark = m.reduce((s, row) => s + row.filter(Boolean).length, 0);
  return p + (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;
}

/** The QR code for `text` as rows of dark (true) and light modules, without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  const { ver, words } = codewords(Array.from(new TextEncoder().encode(text)));
  const size = ver * 4 + 17;
  const mods = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (m: boolean[][], x: number, y: number, dark: boolean) => { m[y][x] = dark; fixed[y][x] = true; };

  for (let i = 0; i < size; i++) { set(mods, 6, i, i % 2 === 0); set(mods, i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(mods, x, y, d !== 2 && d !== 4);
      }
    }
  }
  const align = alignmentPositions(ver), n = align.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(mods, align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  const format = (m: boolean[][], mask: number) => {
    const data = (FORMAT_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(m, 8, i, bit(bits, i));
    set(m, 8, 7, bit(bits, 6));
    set(m, 8, 8, bit(bits, 7));
    set(m, 7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) set(m, 14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) set(m, size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) set(m, 8, size - 15 + i, bit(bits, i));
    set(m, 8, size - 8, true);
  };
  format(mods, 0);  // reserves the format areas before the data goes in
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(mods, a, b, bit(bits, i));
      set(mods, b, a, bit(bits, i));
    }
  }

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < words.length * 8) {
          mods[y][x] = bit(words[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }

  let best: boolean[][] = mods, bestScore = Infinity;
  MASKS.forEach((fn, mask) => {
    const m = mods.map((row, y) => row.map((dark, x) => (!fixed[y][x] && fn(x, y) ? !dark : dark)));
    format(m, mask);
    const score = penalty(m);
    if (score < bestScore) { best = m; bestScore = score; }
  });
  return best;
}
