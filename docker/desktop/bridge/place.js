// Deskfish page bridge — where to click an element.
//
// Pure, no DOM: loaded by the content script (as a plain script) and by the unit tests (as a
// CommonJS module), like score.js. Everything hangs off `DeskfishPlace` on the global object.
//
// The click point used to be the centre of the bounding box. For an inline element whose text wraps
// onto two lines that point is the gap between the lines — outside the element, on whatever is
// behind it — and every tool that printed a coordinate printed that one. The point is chosen from
// the element's line boxes instead: the first one in view whose visible centre really reaches the
// element, as the page itself reports it.
(function (root) {
  'use strict';

  /**
   * Pick the click point for an element.
   *
   * `rects`: the element's client rects as `{ left, top, right, bottom }` in CSS viewport pixels,
   * in document order — `getClientRects()`, or the bounding rect alone when that is empty.
   * `vw`, `vh`: the viewport size. `probe(x, y)`: true when the page reports the element (or one of
   * its descendants) at that point — the content script answers it with `elementFromPoint`.
   *
   * Rule: of the rects that intersect the viewport, in order, the centre of the visible part of the
   * first one the probe accepts is the point (`inView: true, covered: false`). Rects in view but no
   * point accepted: the centre of the largest visible part, `covered: true` — something is in front
   * of it, or the element does not take clicks there. No rect in view: the centre of the union of
   * the rects, `inView: false` (the caller says how far off-screen it is).
   */
  function pick(rects, vw, vh, probe) {
    const boxes = (rects || []).filter((r) => r && r.right > r.left && r.bottom > r.top);
    let largest;
    for (const r of boxes) {
      const x0 = Math.max(0, r.left);
      const y0 = Math.max(0, r.top);
      const x1 = Math.min(vw, r.right);
      const y1 = Math.min(vh, r.bottom);
      if (x1 <= x0 || y1 <= y0) continue;
      const x = (x0 + x1) / 2;
      const y = (y0 + y1) / 2;
      if (probe(x, y)) return { x, y, inView: true, covered: false };
      const area = (x1 - x0) * (y1 - y0);
      if (!largest || area > largest.area) largest = { x, y, area };
    }
    if (largest) return { x: largest.x, y: largest.y, inView: true, covered: true };
    const all = boxes.length ? boxes : rects || [];
    if (!all.length) return { x: 0, y: 0, inView: false, covered: false };
    const u = all.reduce(
      (a, r) => ({ left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom) }),
      { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
    return { x: (u.left + u.right) / 2, y: (u.top + u.bottom) / 2, inView: false, covered: false };
  }

  root.DeskfishPlace = { pick };
})(typeof globalThis !== 'undefined' ? globalThis : this);
