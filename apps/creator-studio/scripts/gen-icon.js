"use strict";
/**
 * scripts/gen-icon.js — generate the DSH Desktop app/tray icons.
 * Pure Node (zlib + hand-rolled PNG encoder), no dependencies.
 *
 *   node scripts/gen-icon.js
 */
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

// ---- PNG plumbing ---------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, pixelFn) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- drawing helpers ------------------------------------------------------
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** signed distance of (x,y) to rounded rect [x0,y0,x1,y1] radius r (in pixels) */
function sdRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const dx = x - cx;
  const dy = y - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

function sdCircle(x, y, cx, cy, r) {
  return Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) - r;
}

// ---- the icon -------------------------------------------------------------
function iconPixel(size) {
  const s = size;
  const r = s * 0.22;              // outer corner radius
  const cx = s / 2;
  // bubble geometry
  const bw = s * 0.58;             // bubble width
  const bh = s * 0.34;             // bubble height
  const bx0 = cx - bw / 2;
  const bx1 = cx + bw / 2;
  const by0 = s * 0.30;
  const by1 = by0 + bh;
  const br = bh / 2;               // bubble corner radius
  // tail triangle
  const tailX = cx + bw * 0.18;
  const tailY = by1 - 2;

  return (x, y) => {
    const px = x + 0.5;
    const py = y + 0.5;
    // outer rounded square, slightly inset
    const inset = s * 0.045;
    const dOut = sdRoundRect(px, py, inset, inset, s - inset, s - inset, r);
    if (dOut > 0) return [0, 0, 0, 0];
    const aa = clamp01(0.5 - dOut);

    // background gradient
    const t = clamp01(py / s);
    let bgR = lerp(23, 13, t);
    let bgG = lerp(38, 22, t);
    let bgB = lerp(66, 38, t);

    // subtle top glow
    const glow = clamp01(1 - Math.abs(py - s * 0.12) / (s * 0.5));
    bgR = lerp(bgR, 40, glow * 0.35);
    bgG = lerp(bgG, 70, glow * 0.35);
    bgB = lerp(bgB, 140, glow * 0.35);

    // chat bubble
    const dBubble = Math.max(sdRoundRect(px, py, bx0, by0, bx1, by1, br), tailPoint(px, py, tailX, tailY, br * 0.55, bx1 - br));
    const inBubble = dBubble < 0;
    let rCol = 79, gCol = 140, bCol = 255;
    if (inBubble) {
      const bt = clamp01((py - by0) / bh);
      rCol = lerp(56, 120, bt);
      gCol = lerp(120, 175, bt);
      bCol = lerp(255, 255, bt);
    }

    // three dots
    const dotR = bh * 0.085;
    const dotYs = by0 + bh * 0.5;
    const dotXs = [bx0 + bw * 0.26, cx, bx0 + bw * 0.74];
    let dot = false;
    for (const dx of dotXs) dot = dot || sdCircle(px, py, dx, dotYs, dotR) < 0;
    if (dot) {
      rCol = 255; gCol = 255; bCol = 255;
    }

    if (inBubble || dot) {
      const bAA = clamp01(0.5 - dBubble);
      return [Math.round(rCol), Math.round(gCol), Math.round(bCol), Math.round(255 * bAA)];
    }
    return [Math.round(bgR), Math.round(bgG), Math.round(bgB), Math.round(255 * aa)];
  };
}

// triangle-ish tail: point at (tx,ty) fanning back into the bubble edge
function tailPoint(px, py, tx, ty, r, rightEdge) {
  // simple approach: distance to a triangle defined by three points
  const ax = tx - r * 1.1, ay = ty;
  const bx = tx + r * 1.1, by = ty;
  const cx2 = tx, cy2 = ty - r * 1.6;
  return distToTri(px, py, ax, ay, bx, by, cx2, cy2);
}

function distToTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 || 1);
  const d2 = Math.abs((cx - bx) * (by - py) - (bx - px) * (cy - by)) / Math.sqrt((cx - bx) ** 2 + (cy - by) ** 2 || 1);
  const d3 = Math.abs((ax - cx) * (cy - py) - (cx - px) * (ay - cy)) / Math.sqrt((ax - cx) ** 2 + (ay - cy) ** 2 || 1);
  // inside test
  const sign = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const v1 = sign(px, py, ax, ay, bx, by);
  const v2 = sign(px, py, bx, by, cx, cy);
  const v3 = sign(px, py, cx, cy, ax, ay);
  const neg = v1 < 0 || v2 < 0 || v3 < 0;
  const pos = v1 > 0 || v2 > 0 || v3 > 0;
  const inside = !(neg && pos);
  return inside ? -Math.min(d1, d2, d3) : Math.min(d1, d2, d3);
}

// ---- main -----------------------------------------------------------------
const outDir = path.join(__dirname, "..", "assets");
fs.mkdirSync(outDir, { recursive: true });

for (const size of [512, 256, 32, 16]) {
  const png = encodePng(size, iconPixel(size));
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}

// Windows .ico (single 256x256 PNG entry — the format modern Windows prefers)
{
  const size = 256;
  const png = encodePng(size, iconPixel(size));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 0 => 256
  entry[1] = 0; // height 0 => 256
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset
  const ico = Buffer.concat([header, entry, png]);
  const file = path.join(outDir, "icon.ico");
  fs.writeFileSync(file, ico);
  console.log(`wrote ${file} (${ico.length} bytes)`);
}
