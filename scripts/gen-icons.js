// Generates PNG icons from scratch (no deps) using Node's built-in zlib.
// Draws the Literature mark: a dark room, three cards fanned as a held hand,
// and a brass pip on the front one. Mirrors icons/icon.svg. Run:
//   node scripts/gen-icons.js
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const BG = [0x0A, 0x0F, 0x16];
const LAMP = [0x18, 0x21, 0x2F];
const CARD_BACK = [0xCF, 0xC6, 0xB2];
const CARD_FRONT = [0xF0, 0xEA, 0xDC];
const INK = [0x1E, 0x24, 0x2B];
const BRASS = [0xC9, 0xA6, 0x6B];

// Geometry, in the same 512-unit design space as icon.svg. The cards pivot about
// a point below the frame, which is what makes a fan look held rather than
// scattered.
const PIVOT = [256, 393];
const FAN = [-24, 0, 24];
const REACH = 150;                 // pivot -> card centre
const CARD = { hw: 74, hh: 105, r: 18 };
const STROKE = 5;
const PIP = { hw: 41, hh: 49 };

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Signed distance to a rounded rectangle centred on the origin. Negative inside. */
function roundRect(x, y, hw, hh, r) {
  const qx = Math.abs(x) - (hw - r);
  const qy = Math.abs(y) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a diamond centred on the origin. Negative inside. */
function diamond(x, y, hw, hh) {
  return (Math.abs(x) * hh + Math.abs(y) * hw - hw * hh) / Math.hypot(hw, hh);
}

function drawIcon(size, scale = 1) {
  const u = size / 512;              // design units -> pixels
  const cx = size / 2, cy = size / 2;
  // Everything below works in design units, so the anti-aliasing width has to be
  // converted the other way: 1.4px expressed as design units at this scale.
  const aa = 1.4 / (u * scale);
  const buf = Buffer.alloc(size * size * 4);

  const cards = FAN.map((deg, i) => {
    const t = (deg * Math.PI) / 180;
    return {
      cos: Math.cos(t),
      sin: Math.sin(t),
      x: PIVOT[0] + REACH * Math.sin(t),
      y: PIVOT[1] - REACH * Math.cos(t),
      fill: deg === 0 ? CARD_FRONT : CARD_BACK,
      front: deg === 0,
      order: i,
    };
  });
  // Back to front, so the middle card lies over the two it hides.
  cards.sort((a, b) => Number(a.front) - Number(b.front));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;

      // Lamplight from above, in pixel space: the background fills the canvas
      // whatever the content scale is.
      const lamp = 1 - smoothstep(0, size * 0.8, Math.hypot(px - cx, py) * 0.95);
      let r = BG[0] * (1 - lamp) + LAMP[0] * lamp;
      let g = BG[1] * (1 - lamp) + LAMP[1] * lamp;
      let b = BG[2] * (1 - lamp) + LAMP[2] * lamp;

      // Pixel -> design coords. scale < 1 shrinks the content towards the centre
      // for the maskable safe area.
      const dx = (px - cx) / (u * scale) + 256;
      const dy = (py - cy) / (u * scale) + 256;

      for (const c of cards) {
        const ox = dx - c.x, oy = dy - c.y;
        const lx = ox * c.cos + oy * c.sin;
        const ly = -ox * c.sin + oy * c.cos;
        const d = roundRect(lx, ly, CARD.hw, CARD.hh, CARD.r);

        const face = 1 - smoothstep(-aa, aa, d);
        if (face <= 0) continue;
        r = r * (1 - face) + c.fill[0] * face;
        g = g * (1 - face) + c.fill[1] * face;
        b = b * (1 - face) + c.fill[2] * face;

        // The stroke keeps overlapping cards apart at 192px, where the fill
        // difference alone is too subtle to separate them.
        const inside = 1 - smoothstep(-STROKE - aa, -STROKE + aa, d);
        const edge = Math.max(0, face - inside);
        r = r * (1 - edge) + INK[0] * edge;
        g = g * (1 - edge) + INK[1] * edge;
        b = b * (1 - edge) + INK[2] * edge;

        if (c.front) {
          const pip = 1 - smoothstep(-aa, aa, diamond(lx, ly, PIP.hw, PIP.hh));
          r = r * (1 - pip) + BRASS[0] * pip;
          g = g * (1 - pip) + BRASS[1] * pip;
          b = b * (1 - pip) + BRASS[2] * pip;
        }
      }

      const i = (y * size + x) * 4;
      buf[i] = Math.round(r); buf[i + 1] = Math.round(g); buf[i + 2] = Math.round(b); buf[i + 3] = 255;
    }
  }
  return buf;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  // rest 0 (compression, filter, interlace)

  // Filter each scanline with filter type 0.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'icons');
const targets = [
  { name: 'icon-192.png', size: 192, scale: 1 },
  { name: 'icon-512.png', size: 512, scale: 1 },
  { name: 'icon-maskable.png', size: 512, scale: 0.7 }, // shrink for safe area
];
for (const t of targets) {
  const png = encodePNG(drawIcon(t.size, t.scale), t.size);
  fs.writeFileSync(path.join(outDir, t.name), png);
  console.log('wrote', t.name, png.length, 'bytes');
}
