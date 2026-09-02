#!/usr/bin/env node
// Generates assets/career-ops.ico and assets/career-ops.icns — the launcher
// icon for both shortcut surfaces: the Windows .lnk and the macOS app bundle
// — plus extension/icons/*.png, the MV3 toolbar/management icon set.
//
//   node scripts/system/make-icon.mjs
//
// All of it is committed, so this only needs re-running when the artwork
// changes. It exists as a script rather than checked-in binary blobs with no
// provenance: an icon nobody can regenerate is an icon nobody can adjust.
//
// No image library. PNG is a container we can write directly (zlib is in the
// standard library); Windows Vista and later accept PNG-compressed icon
// entries at every size, and macOS 10.7 and later accept PNG payloads in
// every modern ICNS slot — so both containers hold the same PNGs.
//
// Artwork: the ⚡ from the panel header, white on the panel's own accent
// colour, so the taskbar button and the in-page panel read as one thing.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../../lib/repo-root.mjs';

const ASSETS = path.join(REPO_ROOT, 'assets');
const OUT_ICO = path.join(ASSETS, 'career-ops.ico');
const OUT_ICNS = path.join(ASSETS, 'career-ops.icns');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUPERSAMPLE = 4; // render big, box-filter down — that is the anti-aliasing

// --co-accent from extension/companion.js, darkened along the diagonal.
const TOP = [0x6f, 0x66, 0xdb];
const BOTTOM = [0x43, 0x3b, 0xa6];
const BOLT = [0xff, 0xff, 0xff];

// Lightning bolt, in 0..1 of the icon box.
const BOLT_POLY = [
  [0.585, 0.055], [0.255, 0.560], [0.455, 0.560],
  [0.395, 0.945], [0.735, 0.430], [0.530, 0.430],
];

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

/** Even-odd point-in-polygon. */
function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Inside a rounded rectangle inset by `pad`, corner radius `r` (all 0..1). */
function inRoundedRect(x, y, pad, r) {
  const lo = pad;
  const hi = 1 - pad;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + r), hi - r);
  const cy = Math.min(Math.max(y, lo + r), hi - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** RGBA pixels for one icon size, rendered at SUPERSAMPLE× and averaged down. */
function render(size) {
  const big = size * SUPERSAMPLE;
  const hi = new Uint8Array(big * big * 4);
  for (let py = 0; py < big; py += 1) {
    for (let px = 0; px < big; px += 1) {
      const x = (px + 0.5) / big;
      const y = (py + 0.5) / big;
      const i = (py * big + px) * 4;
      if (!inRoundedRect(x, y, 0.02, 0.21)) continue; // transparent outside the tile
      const t = (x + y) / 2;
      const bolt = inside(BOLT_POLY, x, y);
      hi[i] = bolt ? BOLT[0] : lerp(TOP[0], BOTTOM[0], t);
      hi[i + 1] = bolt ? BOLT[1] : lerp(TOP[1], BOTTOM[1], t);
      hi[i + 2] = bolt ? BOLT[2] : lerp(TOP[2], BOTTOM[2], t);
      hi[i + 3] = 255;
    }
  }
  // Box downsample. Averaging premultiplied colour keeps transparent pixels
  // from dragging the edges toward black.
  const out = Buffer.alloc(size * size * 4);
  const n = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const i = ((y * SUPERSAMPLE + sy) * big + (x * SUPERSAMPLE + sx)) * 4;
          const alpha = hi[i + 3] / 255;
          r += hi[i] * alpha;
          g += hi[i + 1] * alpha;
          b += hi[i + 2] * alpha;
          a += hi[i + 3];
        }
      }
      const alpha = a / n;
      const o = (y * size + x) * 4;
      const scale = alpha > 0 ? 255 / alpha : 0;
      out[o] = Math.round((r / n) * scale);
      out[o + 1] = Math.round((g / n) * scale);
      out[o + 2] = Math.round((b / n) * scale);
      out[o + 3] = Math.round(alpha);
    }
  }
  return out;
}

// ── PNG ─────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  // 10-12: compression, filter, interlace — all 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// One render per size, shared by both containers.
const pngCache = new Map();
const pngFor = (size) => {
  if (!pngCache.has(size)) pngCache.set(size, png(size, render(size)));
  return pngCache.get(size);
};

// ── ICO ─────────────────────────────────────────────────────────────────────
const images = SIZES.map((size) => ({ size, data: pngFor(size) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const entries = images.map(({ size, data }) => {
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // 0 means 256
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; // palette colours
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += data.length;
  return entry;
});

mkdirSync(ASSETS, { recursive: true });
writeFileSync(OUT_ICO, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
console.log(`wrote ${OUT_ICO} — ${SIZES.join('/')}px, ${(offset / 1024).toFixed(1)} KB`);

// ── ICNS ────────────────────────────────────────────────────────────────────
// 'icns' magic + big-endian total length, then typed chunks whose payload is a
// PNG. The icNN retina slots carry the same pixels as their 2× base size; both
// are included so every surface from a Finder list row to the Dock has an
// exact-size match instead of a scale.
const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64],                 // 16 / 32 / 64
  ['ic07', 128], ['ic08', 256], ['ic09', 512],              // 128 / 256 / 512
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512], // 16@2x … 256@2x
];
const chunks = ICNS_TYPES.map(([type, size]) => {
  const data = pngFor(size);
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
});
const icnsBody = Buffer.concat(chunks);
const icnsHead = Buffer.alloc(8);
icnsHead.write('icns', 0, 'ascii');
icnsHead.writeUInt32BE(icnsBody.length + 8, 4);
writeFileSync(OUT_ICNS, Buffer.concat([icnsHead, icnsBody]));
console.log(`wrote ${OUT_ICNS} — ${ICNS_TYPES.map(([t, s]) => `${t}:${s}`).join(' ')}, ${((icnsBody.length + 8) / 1024).toFixed(1)} KB`);

// ── extension icons ─────────────────────────────────────────────────────────
// MV3's `icons` / `action.default_icon` want plain PNGs, one file per size —
// no container. Same artwork, same render cache; only the sizes MV3 actually
// asks for (16 toolbar, 32 Windows taskbar DPI, 48 chrome://extensions/
// management page, 128 the Chrome Web Store / install prompt).
const EXT_ICONS_DIR = path.join(REPO_ROOT, 'extension', 'icons');
const EXT_ICON_SIZES = [16, 32, 48, 128];
mkdirSync(EXT_ICONS_DIR, { recursive: true });
for (const size of EXT_ICON_SIZES) {
  writeFileSync(path.join(EXT_ICONS_DIR, `icon-${size}.png`), pngFor(size));
}
console.log(`wrote ${EXT_ICONS_DIR} — ${EXT_ICON_SIZES.map((s) => `icon-${s}.png`).join(', ')}`);
