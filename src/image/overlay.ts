/**
 * Tiny RGBA drawing helpers for the two overlays the agent sees:
 *   - the pointer crosshair stamped on every screenshot (scrot doesn't capture the cursor)
 *   - the rulers / grid / labels of the zoom view
 * Pure JS on raw RGBA buffers, same zero-native-deps policy as resize.ts.
 */

export interface Raster {
  data: Buffer;
  width: number;
  height: number;
}

export type Rgb = readonly [number, number, number];

export const RED: Rgb = [220, 38, 38];
export const BLUE: Rgb = [37, 99, 235];
export const WHITE: Rgb = [255, 255, 255];
export const BAND: Rgb = [32, 32, 36];

export function blend(r: Raster, x: number, y: number, rgb: Rgb, alpha = 1): void {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  const i = (y * r.width + x) * 4;
  r.data[i] = rgb[0] * alpha + r.data[i] * (1 - alpha);
  r.data[i + 1] = rgb[1] * alpha + r.data[i + 1] * (1 - alpha);
  r.data[i + 2] = rgb[2] * alpha + r.data[i + 2] * (1 - alpha);
  r.data[i + 3] = 255;
}

export function fillRect(r: Raster, x: number, y: number, w: number, h: number, rgb: Rgb, alpha = 1): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      blend(r, x + dx, y + dy, rgb, alpha);
    }
  }
}

/** 5×7 bitmap digits, enough for coordinate labels. */
const DIGITS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

export const DIGIT_W = 5;
export const DIGIT_H = 7;

/** Width in pixels of `text` drawn by drawDigits at `scale`. */
export function digitsWidth(text: string, scale = 2): number {
  return text.length * (DIGIT_W + 1) * scale - scale;
}

/** Draw a number string (digits only; other characters become a space). */
export function drawDigits(r: Raster, x: number, y: number, text: string, rgb: Rgb, scale = 2): void {
  let cx = x;
  for (const ch of text) {
    const glyph = DIGITS[ch];
    if (glyph) {
      for (let gy = 0; gy < DIGIT_H; gy++) {
        for (let gx = 0; gx < DIGIT_W; gx++) {
          if (glyph[gy][gx] === '1') fillRect(r, cx + gx * scale, y + gy * scale, scale, scale, rgb);
        }
      }
    }
    cx += (DIGIT_W + 1) * scale;
  }
}

/**
 * A crosshair with a gap at the center, so the pixel it points at stays visible.
 * White casing under a colored core keeps it legible on any background.
 */
export function drawCrosshair(r: Raster, x: number, y: number, rgb: Rgb = RED): void {
  const inner = 3; // gap radius around the center
  const outer = 11;
  const len = outer - inner;
  // casing
  fillRect(r, x - outer, y - 1, len, 3, WHITE);
  fillRect(r, x + inner + 1, y - 1, len, 3, WHITE);
  fillRect(r, x - 1, y - outer, 3, len, WHITE);
  fillRect(r, x - 1, y + inner + 1, 3, len, WHITE);
  // core
  fillRect(r, x - outer, y, len, 1, rgb);
  fillRect(r, x + inner + 1, y, len, 1, rgb);
  fillRect(r, x, y - outer, 1, len, rgb);
  fillRect(r, x, y + inner + 1, 1, len, rgb);
}
