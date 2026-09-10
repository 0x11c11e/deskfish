import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';
import { drawCrosshair } from './overlay';

export interface ScaledImage {
  jpeg: Buffer;
  width: number;
  height: number;
  /** 128-bit average hash of the frame (before the pointer crosshair), hex. Near-identical screens hash alike. Absent on zoom views. */
  hash?: string;
  /** Grayscale thumbnail (before the crosshair), `thumbW`×`thumbH` bytes, for frame-to-frame change detection. Absent on zoom views. */
  thumb?: Uint8Array;
  thumbW?: number;
  thumbH?: number;
}

/**
 * Fraction of thumbnail pixels that changed noticeably between two frames (0 = identical). A scroll
 * or a page change moves most of them; a ticked checkbox or a typed word moves a few; a blinking
 * caret moves almost none. Frames without thumbnails or of different sizes count as fully changed.
 */
export function frameDiff(a: ScaledImage, b: ScaledImage, region?: FrameRegion): number {
  if (!a.thumb || !b.thumb || a.thumbW !== b.thumbW || a.thumbH !== b.thumbH || !a.thumb.length) return 1;
  const w = a.thumbW!;
  const h = a.thumbH!;
  const x0 = region ? Math.max(0, Math.min(w - 1, Math.floor(region.x0 * w))) : 0;
  const y0 = region ? Math.max(0, Math.min(h - 1, Math.floor(region.y0 * h))) : 0;
  const x1 = region ? Math.max(x0 + 1, Math.min(w, Math.ceil(region.x1 * w))) : w;
  const y1 = region ? Math.max(y0 + 1, Math.min(h, Math.ceil(region.y1 * h))) : h;
  let changed = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (Math.abs(a.thumb[i] - b.thumb[i]) > 24) changed++;
    }
  }
  return changed / ((x1 - x0) * (y1 - y0));
}

/** A part of the frame, as fractions of its width and height (0..1), for `frameDiff`. */
export interface FrameRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function thumbnail(rgba: Uint8Array | Buffer, w: number, h: number, tw: number): { thumb: Uint8Array; thumbW: number; thumbH: number } {
  const th = Math.max(1, Math.round((h * tw) / w));
  const out = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / tw));
      const i = (sy * w + sx) * 4;
      out[y * tw + x] = (rgba[i] * 77 + rgba[i + 1] * 151 + rgba[i + 2] * 28) >> 8;
    }
  }
  return { thumb: out, thumbW: tw, thumbH: th };
}

/** Hamming distance between two hashes from `scalePng` (0 = same picture; ≤ 4 = visually unchanged). */
export function hashDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d + Math.abs(a.length - b.length) * 4;
}

/** Average hash over a 16×8 grid of grayscale cell means. */
function averageHash(rgba: Uint8Array | Buffer, w: number, h: number): string {
  const cols = 16;
  const rows = 8;
  const cells: number[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * w) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / cols));
      const y0 = Math.floor((cy * h) / rows);
      const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / rows));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * w + x) * 4;
          sum += rgba[i] * 0.3 + rgba[i + 1] * 0.59 + rgba[i + 2] * 0.11;
          n++;
        }
      }
      cells.push(sum / n);
    }
  }
  const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
  let hex = '';
  for (let i = 0; i < cells.length; i += 4) {
    let nibble = 0;
    for (let b = 0; b < 4; b++) if (cells[i + b] > mean) nibble |= 1 << (3 - b);
    hex += nibble.toString(16);
  }
  return hex;
}

/**
 * Downscale a PNG screenshot to `targetWidth` (aspect ratio preserved) and encode it as JPEG.
 * `marker` (in scaled coordinates) stamps a red crosshair — used to show the model where the
 * mouse pointer is, since the daemon's scrot screenshots don't include the cursor.
 *
 * Pure JS (pngjs + jpeg-js) so the extension has no native dependencies. Area averaging keeps small
 * UI text legible, which matters more than speed here — one image per agent step.
 */
export function scalePng(png: Buffer, targetWidth: number, quality = 80, marker?: { x: number; y: number }): ScaledImage {
  const src = PNG.sync.read(png);
  const scale = Math.min(1, targetWidth / src.width);
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));

  let rgba: Buffer;
  if (w === src.width && h === src.height) {
    rgba = src.data;
  } else {
    rgba = Buffer.alloc(w * h * 4);
    const sw = src.width;
    const sh = src.height;
    const sd = src.data;
    for (let dy = 0; dy < h; dy++) {
      const sy0 = Math.floor((dy * sh) / h);
      const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * sh) / h));
      for (let dx = 0; dx < w; dx++) {
        const sx0 = Math.floor((dx * sw) / w);
        const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * sw) / w));
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let y = sy0; y < sy1; y++) {
          let i = (y * sw + sx0) * 4;
          for (let x = sx0; x < sx1; x++) {
            r += sd[i];
            g += sd[i + 1];
            b += sd[i + 2];
            n++;
            i += 4;
          }
        }
        const o = (dy * w + dx) * 4;
        rgba[o] = r / n;
        rgba[o + 1] = g / n;
        rgba[o + 2] = b / n;
        rgba[o + 3] = 255;
      }
    }
  }

  const hash = averageHash(rgba, w, h);
  const thumb = thumbnail(rgba, w, h, 320);
  if (marker) drawCrosshair({ data: rgba, width: w, height: h }, Math.round(marker.x), Math.round(marker.y));

  const encoded = jpeg.encode({ data: rgba, width: w, height: h }, quality);
  return { jpeg: Buffer.from(encoded.data), width: w, height: h, hash, ...thumb };
}
