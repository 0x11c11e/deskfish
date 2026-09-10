import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';
import type { ScaledImage } from './resize';
import { BAND, BLUE, RED, WHITE, type Raster, blend, digitsWidth, drawCrosshair, drawDigits, fillRect } from './overlay';

/**
 * The zoom view: a magnified crop of the screen with a coordinate ruler, for reading small text
 * and finding exact click points.
 *
 * Everything is labeled in the model's own coordinate space (the scaled screenshot), so there is
 * no second coordinate system: the model reads a position off the grid and clicks it directly.
 * The crop is taken from the *native* PNG, so when the display is larger than the screenshots the
 * model normally sees, zooming recovers real detail rather than enlarging JPEG artifacts.
 */

export const ZOOM_FACTOR = 3;
/** Grid lines and ruler labels every 50 screenshot pixels, minor ruler ticks every 10. */
export const GRID_STEP = 50;
export const TICK_STEP = 10;
/** Ruler band sizes (left band fits a 4-digit label at 2× font). */
export const BAND_TOP = 18;
export const BAND_LEFT = 38;

export interface ZoomSpec {
  /** Cropped region, in scaled-screenshot coordinates. */
  crop: { x: number; y: number; w: number; h: number };
  /** Output pixels per scaled-screenshot pixel. */
  factor: number;
}

/** A third of the screen in each dimension, centered on `center`, clamped to stay on screen. */
export function zoomSpec(center: { x: number; y: number }, screen: { width: number; height: number }): ZoomSpec {
  const w = Math.min(screen.width, Math.round(screen.width / 3));
  const h = Math.min(screen.height, Math.round(screen.height / 3));
  const x = clamp(Math.round(center.x - w / 2), 0, screen.width - w);
  const y = clamp(Math.round(center.y - h / 2), 0, screen.height - h);
  return { crop: { x, y, w, h }, factor: ZOOM_FACTOR };
}

export interface ZoomView {
  image: ScaledImage;
  spec: ZoomSpec;
  /** What to tell the model alongside the image. */
  message: string;
}

/**
 * @param nativePng screenshot at native display resolution
 * @param center    point of interest in scaled-screenshot coordinates
 * @param screen    size of the scaled screenshots the model sees
 * @param scale     native pixels per scaled pixel, per axis
 */
export function renderZoom(
  nativePng: Buffer,
  center: { x: number; y: number },
  screen: { width: number; height: number },
  scale: { x: number; y: number },
  quality = 85,
): ZoomView {
  const src = PNG.sync.read(nativePng);
  const spec = zoomSpec(
    { x: clamp(center.x, 0, screen.width - 1), y: clamp(center.y, 0, screen.height - 1) },
    screen,
  );
  const { crop, factor } = spec;

  const contentW = crop.w * factor;
  const contentH = crop.h * factor;
  const out: Raster = {
    width: BAND_LEFT + contentW,
    height: BAND_TOP + contentH,
    data: Buffer.alloc((BAND_LEFT + contentW) * (BAND_TOP + contentH) * 4),
  };

  // Magnified content: nearest neighbor from the native image, crisp for text.
  for (let oy = 0; oy < contentH; oy++) {
    const sy = crop.y + (oy + 0.5) / factor; // scaled-space y
    const ny = clamp(Math.floor(sy * scale.y), 0, src.height - 1);
    for (let ox = 0; ox < contentW; ox++) {
      const sx = crop.x + (ox + 0.5) / factor;
      const nx = clamp(Math.floor(sx * scale.x), 0, src.width - 1);
      const si = (ny * src.width + nx) * 4;
      const di = ((BAND_TOP + oy) * out.width + (BAND_LEFT + ox)) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = 255;
    }
  }

  // Ruler bands.
  fillRect(out, 0, 0, out.width, BAND_TOP, BAND);
  fillRect(out, 0, 0, BAND_LEFT, out.height, BAND);

  // Vertical grid lines + top labels (x coordinates).
  for (let gx = Math.ceil(crop.x / TICK_STEP) * TICK_STEP; gx <= crop.x + crop.w; gx += TICK_STEP) {
    const ox = BAND_LEFT + Math.round((gx - crop.x) * factor);
    if (ox >= out.width) break;
    if (gx % GRID_STEP === 0) {
      dottedV(out, ox, BAND_TOP, out.height);
      const label = String(gx);
      const lx = clamp(ox - Math.round(digitsWidth(label) / 2), BAND_LEFT + 1, out.width - digitsWidth(label) - 1);
      drawDigits(out, lx, 2, label, WHITE);
    } else {
      fillRect(out, ox, BAND_TOP - 4, 1, 4, WHITE); // minor tick
    }
  }

  // Horizontal grid lines + left labels (y coordinates).
  for (let gy = Math.ceil(crop.y / TICK_STEP) * TICK_STEP; gy <= crop.y + crop.h; gy += TICK_STEP) {
    const oy = BAND_TOP + Math.round((gy - crop.y) * factor);
    if (oy >= out.height) break;
    if (gy % GRID_STEP === 0) {
      dottedH(out, oy, BAND_LEFT, out.width);
      const label = String(gy);
      const ly = clamp(oy - 7, BAND_TOP + 1, out.height - 15);
      drawDigits(out, BAND_LEFT - 4 - digitsWidth(label), ly, label, WHITE);
    } else {
      fillRect(out, BAND_LEFT - 4, oy, 4, 1, WHITE); // minor tick
    }
  }

  // The point the model asked about (blue, to stay distinct from the red pointer crosshair).
  drawCrosshair(out, BAND_LEFT + Math.round((center.x - crop.x) * factor), BAND_TOP + Math.round((center.y - crop.y) * factor), BLUE);

  const encoded = jpeg.encode({ data: out.data, width: out.width, height: out.height }, quality);
  const message =
    `Zoomed ${factor}× into x ${crop.x}–${crop.x + crop.w}, y ${crop.y}–${crop.y + crop.h}. ` +
    `The rulers and dotted grid lines (every ${GRID_STEP} px) are an overlay labeled in normal screenshot coordinates — ` +
    `read your target's position off them and click it with those exact coordinates. ` +
    `The blue crosshair marks the point you asked about.`;
  return { image: { jpeg: Buffer.from(encoded.data), width: out.width, height: out.height }, spec, message };
}

function dottedV(r: Raster, x: number, y0: number, y1: number): void {
  for (let y = y0; y < y1; y++) {
    if ((y >> 2) & 1) continue; // 4 px on, 4 px off
    blend(r, x, y, RED, 0.55);
  }
}

function dottedH(r: Raster, y: number, x0: number, x1: number): void {
  for (let x = x0; x < x1; x++) {
    if ((x >> 2) & 1) continue;
    blend(r, x, y, RED, 0.55);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
