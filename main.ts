// png-squeeze: lossless PNG re-encoder for 1280x720 RGBA screenshots.
//
// Strategy (all work is fixed-count; no clock, no environment, no network):
//  1. Parse the stored input PNG (colour type 6, 8 bit) into raw RGBA rows.
//  2. Reduce the colour type when lossless: palette (<=256 distinct RGBA
//     colours, first-appearance order, tRNS when any alpha < 255), grey
//     (colour type 0), grey+alpha (type 4), RGB (type 2), else RGBA (type 6).
//  3. Build two filtered streams: fixed filter 0, and a per-band filter
//     choice (bands of 60 rows; each band's filter is the one whose
//     zlib-level-6 size is smallest, tried independently per band).
//  4. Rank the two streams by plain zlib level 6 size, then re-encode the
//     winner as one zlib stream at level 9 with a SYNC_FLUSH block boundary
//     every 90 rows (fresh Huffman tables per block suit mixed content).
//  5. Emit a minimal PNG: IHDR, PLTE/tRNS when needed, one IDAT, IEND.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const WIDTH = 1280;
const HEIGHT = 720;
const BAND_ROWS = 60;
const CHUNK_ROWS = 90;

// ---------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// ---------------------------------------------------------------- PNG in
function parsePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error('input is not 8-bit RGBA');
  if (width !== WIDTH || height !== HEIGHT) throw new Error('input is not 1280x720');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rows = new Array(height);
  const zero = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1);
    const f = raw[off];
    const src = raw.subarray(off + 1, off + 1 + stride);
    const up = y > 0 ? rows[y - 1] : zero;
    const dst = Buffer.alloc(stride);
    if (f === 0) {
      src.copy(dst);
    } else if (f === 1) {
      for (let i = 0; i < stride; i++) dst[i] = (src[i] + (i >= 4 ? dst[i - 4] : 0)) & 0xff;
    } else if (f === 2) {
      for (let i = 0; i < stride; i++) dst[i] = (src[i] + up[i]) & 0xff;
    } else if (f === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= 4 ? dst[i - 4] : 0;
        dst[i] = (src[i] + ((left + up[i]) >> 1)) & 0xff;
      }
    } else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? dst[i - 4] : 0;
        const b = up[i];
        const c = i >= 4 ? up[i - 4] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        dst[i] = (src[i] + pr) & 0xff;
      }
    } else {
      throw new Error('bad input filter ' + f);
    }
    rows[y] = dst;
  }
  return { width, height, rows };
}

// ---------------------------------------------------------------- Filter
function filterRow(raw, up, bpp, f, out) {
  const w = raw.length;
  for (let i = 0; i < w; i++) {
    const x = raw[i];
    const left = i >= bpp ? raw[i - bpp] : 0;
    const u = up ? up[i] : 0;
    const ul = up && i >= bpp ? up[i - bpp] : 0;
    let v;
    if (f === 0) v = x;
    else if (f === 1) v = (x - left) & 0xff;
    else if (f === 2) v = (x - u) & 0xff;
    else if (f === 3) v = (x - ((left + u) >> 1)) & 0xff;
    else {
      const p = left + u - ul;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - u);
      const pc = Math.abs(p - ul);
      v = (x - (pa <= pb && pa <= pc ? left : pb <= pc ? u : ul)) & 0xff;
    }
    out[i] = v;
  }
}

// ------------------------------------------------------- Colour reduction
function reduce(rows) {
  const uniq = new Map();
  let grey = true;
  let alphaAll255 = true;
  for (const row of rows) {
    for (let i = 0; i < row.length; i += 4) {
      const r = row[i];
      const g = row[i + 1];
      const b = row[i + 2];
      const a = row[i + 3];
      if (r !== g || g !== b) grey = false;
      if (a !== 255) alphaAll255 = false;
      const key = (r << 24) | (g << 16) | (b << 8) | a;
      if (!uniq.has(key)) uniq.set(key, uniq.size);
    }
  }
  if (uniq.size <= 256 && !grey) {
    const palette = Buffer.alloc(uniq.size * 3);
    const alphas = new Uint8Array(uniq.size);
    let lastAlpha = 0;
    for (const [key, idx] of uniq) {
      palette[idx * 3] = (key >>> 24) & 0xff;
      palette[idx * 3 + 1] = (key >>> 16) & 0xff;
      palette[idx * 3 + 2] = (key >>> 8) & 0xff;
      alphas[idx] = key & 0xff;
      if ((key & 0xff) !== 255) lastAlpha = idx + 1;
    }
    const trns = alphaAll255 ? null : Buffer.from(alphas.subarray(0, lastAlpha));
    const reduced = new Array(HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
      const src = rows[y];
      const dst = Buffer.alloc(WIDTH);
      for (let x = 0; x < WIDTH; x++) {
        const i = x * 4;
        dst[x] = uniq.get((src[i] << 24) | (src[i + 1] << 16) | (src[i + 2] << 8) | src[i + 3]);
      }
      reduced[y] = dst;
    }
    return { reduced, bpp: 1, colorType: 3, palette, trns };
  }
  if (grey && alphaAll255) {
    const reduced = new Array(HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
      const src = rows[y];
      const dst = Buffer.alloc(WIDTH);
      for (let x = 0; x < WIDTH; x++) dst[x] = src[x * 4];
      reduced[y] = dst;
    }
    return { reduced, bpp: 1, colorType: 0, palette: null, trns: null };
  }
  if (grey) {
    const reduced = new Array(HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
      const src = rows[y];
      const dst = Buffer.alloc(WIDTH * 2);
      for (let x = 0; x < WIDTH; x++) {
        dst[x * 2] = src[x * 4];
        dst[x * 2 + 1] = src[x * 4 + 3];
      }
      reduced[y] = dst;
    }
    return { reduced, bpp: 2, colorType: 4, palette: null, trns: null };
  }
  if (alphaAll255) {
    const reduced = new Array(HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
      const src = rows[y];
      const dst = Buffer.alloc(WIDTH * 3);
      for (let x = 0; x < WIDTH; x++) {
        dst[x * 3] = src[x * 4];
        dst[x * 3 + 1] = src[x * 4 + 1];
        dst[x * 3 + 2] = src[x * 4 + 2];
      }
      reduced[y] = dst;
    }
    return { reduced, bpp: 3, colorType: 2, palette: null, trns: null };
  }
  return { reduced: rows, bpp: 4, colorType: 6, palette: null, trns: null };
}

// ------------------------------------------- Filtered-stream construction
function fixedZeroStream(reduced, bpp) {
  const rowLen = reduced[0].length;
  const out = Buffer.alloc(HEIGHT * (rowLen + 1));
  for (let y = 0; y < HEIGHT; y++) {
    out[y * (rowLen + 1)] = 0;
    reduced[y].copy(out, y * (rowLen + 1) + 1);
  }
  return out;
}

function bandStream(reduced, bpp) {
  const rowLen = reduced[0].length;
  const out = Buffer.alloc(HEIGHT * (rowLen + 1));
  const tmp = Buffer.alloc(rowLen);
  const bandBuf = Buffer.alloc(BAND_ROWS * (rowLen + 1));
  for (let y0 = 0; y0 < HEIGHT; y0 += BAND_ROWS) {
    const y1 = Math.min(HEIGHT, y0 + BAND_ROWS);
    let bestF = 0;
    let bestSize = Infinity;
    for (let f = 0; f < 5; f++) {
      let p = 0;
      for (let y = y0; y < y1; y++) {
        filterRow(reduced[y], y > 0 ? reduced[y - 1] : null, bpp, f, tmp);
        bandBuf[p++] = f;
        tmp.copy(bandBuf, p);
        p += rowLen;
      }
      const z = zlib.deflateSync(bandBuf.subarray(0, p), { level: 6 }).length;
      if (z < bestSize) {
        bestSize = z;
        bestF = f;
      }
    }
    for (let y = y0; y < y1; y++) {
      filterRow(reduced[y], y > 0 ? reduced[y - 1] : null, bpp, bestF, tmp);
      out[y * (rowLen + 1)] = bestF;
      tmp.copy(out, y * (rowLen + 1) + 1);
    }
  }
  return out;
}

// --------------------------------------- Chunked zlib (one stream, level 9)
function chunkedDeflate(stream, groupBytes) {
  return new Promise((resolve, reject) => {
    const d = zlib.createDeflate({ level: 9, memLevel: 9 });
    const parts = [];
    d.on('data', (c) => parts.push(c));
    d.on('error', reject);
    d.on('end', () => resolve(Buffer.concat(parts)));
    let pos = 0;
    (function next() {
      if (pos >= stream.length) {
        d.end();
        return;
      }
      const end = Math.min(pos + groupBytes, stream.length);
      d.write(stream.subarray(pos, end));
      pos = end;
      if (pos < stream.length) d.flush(zlib.constants.Z_SYNC_FLUSH, next);
      else d.end();
    })();
  });
}

// ---------------------------------------------------------------- PNG out
function encodePng(colorType, palette, trns, zlibData) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];
  if (palette) parts.push(chunk('PLTE', palette));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', zlibData));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function fallbackPng() {
  const rowLen = WIDTH * 4;
  const stream = Buffer.alloc(HEIGHT * (rowLen + 1));
  const z = zlib.deflateSync(stream, { level: 6 });
  return encodePng(6, null, null, z);
}

async function squeezeOne(inputBuf) {
  const { rows } = parsePng(inputBuf);
  const { reduced, bpp, colorType, palette, trns } = reduce(rows);
  const rowLen = reduced[0].length;
  const sFixed = fixedZeroStream(reduced, bpp);
  const sBand = bandStream(reduced, bpp);
  const rankFixed = zlib.deflateSync(sFixed, { level: 6 }).length;
  const rankBand = zlib.deflateSync(sBand, { level: 6 }).length;
  const winner = rankBand <= rankFixed ? sBand : sFixed;
  const z = await chunkedDeflate(winner, CHUNK_ROWS * (rowLen + 1));
  return encodePng(colorType, palette, trns, z);
}

async function main() {
  // The harness mounts the input and output directories and tells the
  // program where they are: MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR (the
  // process driver passes the mounts as environment variables; the docker
  // sandbox mounts them literally at /input and /output). Optional argv
  // overrides exist only for local testing. These are locations, never a
  // source of variation in the output.
  const inputDir = process.env.MAKEFUN_INPUT_DIR || process.argv[2] || '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || process.argv[3] || '/output';
  for (let k = 1; k <= 8; k++) {
    const id = 'i' + String(k).padStart(3, '0');
    const outDir = path.join(outputDir, id);
    fs.mkdirSync(outDir, { recursive: true });
    let png;
    try {
      const inputBuf = fs.readFileSync(path.join(inputDir, id, 'image.png'));
      png = await squeezeOne(inputBuf);
    } catch {
      png = fallbackPng();
    }
    fs.writeFileSync(path.join(outDir, 'image.png'), png);
  }
}

await main();
