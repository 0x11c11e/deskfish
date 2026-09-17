// Renders media/icon-app.svg into the app's icons: app/icons/png/<n>x<n>.png (Linux, the window),
// icon.icns (macOS), icon.ico (Windows), tray.png and tray@2x.png. `npm run icons`; the output is
// committed, so a release needs no image library. The SVG is rasterised by sharp (Lovell Fuller,
// London; librsvg inside), from app/node_modules; icns and ico are written here: both formats can
// hold PNG data as it is.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sharp = createRequire(path.join(root, 'app', 'package.json'))('sharp');
const svg = fs.readFileSync(path.join(root, 'media', 'icon-app.svg'));
const out = path.join(root, 'app', 'icons');
fs.mkdirSync(path.join(out, 'png'), { recursive: true });

const png = (size) => sharp(svg, { density: Math.max(72, (72 * size) / 256) }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const pngs = new Map();
for (const size of sizes) {
  const buf = await png(size);
  pngs.set(size, buf);
  fs.writeFileSync(path.join(out, 'png', `${size}x${size}.png`), buf);
}
fs.writeFileSync(path.join(out, 'tray.png'), pngs.get(32));
fs.writeFileSync(path.join(out, 'tray@2x.png'), pngs.get(64));

// ICNS: 'icns' + total length, then entries of (type, length incl. 8-byte header, PNG bytes).
const ICNS = [['icp4', 16], ['icp5', 32], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
const entries = ICNS.map(([type, size]) => {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(8 + pngs.get(size).length, 4);
  return Buffer.concat([head, pngs.get(size)]);
});
const icnsHead = Buffer.alloc(8);
icnsHead.write('icns', 0, 'ascii');
icnsHead.writeUInt32BE(8 + entries.reduce((n, e) => n + e.length, 0), 4);
fs.writeFileSync(path.join(out, 'icon.icns'), Buffer.concat([icnsHead, ...entries]));

// ICO: a 6-byte header, a 16-byte directory entry per image (0 means 256), then the PNGs.
const ICO = [16, 24, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(ICO.length, 4);
let offset = 6 + 16 * ICO.length;
const dir = ICO.map((size) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0);
  e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(pngs.get(size).length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs.get(size).length;
  return e;
});
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, ...dir, ...ICO.map((s) => pngs.get(s))]));

console.log(`icons: ${sizes.length} PNGs, icon.icns, icon.ico, tray.png → ${path.relative(root, out)}`);
