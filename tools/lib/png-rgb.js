// Compact PNG writer for the opaque textures of the asset generators: 8-bit RGB,
// adaptive per-row filtering and maximum deflate, so procedural noise textures
// stay small. pixel(x, y) returns [r, g, b] (y = 0 is the top row).

const zlib = require('zlib');
const { crc32 } = require('./glb-builder');

const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function makePngRgb(width, height, pixel) {
  const stride = width * 3;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      row[x * 3] = p[0]; row[x * 3 + 1] = p[1]; row[x * 3 + 2] = p[2];
    }
    rows.push(row);
  }
  const out = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const cur = rows[y], prev = y ? rows[y - 1] : Buffer.alloc(stride);
    let best = null, bestSum = Infinity, bestType = 0;
    for (let type = 0; type < 5; type++) {
      const f = Buffer.alloc(stride);
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? cur[i - 3] : 0, b = prev[i], c = i >= 3 ? prev[i - 3] : 0;
        const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (cur[i] - pred) & 255;
        f[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; bestType = type; }
    }
    out[y * (stride + 1)] = bestType;
    best.copy(out, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    return Buffer.concat([be32(data.length), body, be32(crc32(body))]);
  };
  const ihdr = Buffer.concat([be32(width), be32(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { makePngRgb };
