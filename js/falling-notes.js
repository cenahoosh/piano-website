// Falling-notes view: draws a song's notes as bars that fall onto the keyboard.
//
// const view = createFallingNotes(canvas, song);
// view.setLayout(keyboard.layout(canvas));   // key x/width in canvas pixels
// view.render(songTime, { muted: { left: true }, loop: { start, end } });
//
// The bottom edge of the canvas is the "now" line: a bar's lower edge reaches it
// exactly when the note sounds, and its length is the note's duration. Only the
// notes inside the visible time window are drawn (found by binary search), so the
// cost per frame does not grow with the length of the song.

import { isBlack, noteToMidi, persianNoteName, toPersianDigits } from './notes.js';

const HANDS = ['right', 'left'];

function cssColor(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Mix a #rrggbb colour with white. */
function lighten(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(n >> 16)} ${mix((n >> 8) & 255)} ${mix(n & 255)})`;
}

/** First index i with values[i] >= target. */
function lowerBound(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function createFallingNotes(canvas, song) {
  const ctx = canvas.getContext('2d', { alpha: true });

  // ── Song data in flat typed arrays, sorted by start time ─────────
  const sorted = [...song.notes].sort((a, b) => a.time - b.time);
  const count = sorted.length;
  const start = new Float64Array(count);
  const end = new Float64Array(count);
  const midi = new Uint8Array(count);
  const hand = new Uint8Array(count); // 0 = right, 1 = left
  const label = new Array(count);
  let maxDuration = 0;
  sorted.forEach((n, i) => {
    start[i] = n.time;
    end[i] = n.time + n.duration;
    midi[i] = noteToMidi(n.note);
    hand[i] = n.hand === 'left' ? 1 : 0;
    label[i] = persianNoteName(midi[i]).name.split(' ')[0];
    maxDuration = Math.max(maxDuration, n.duration);
  });
  const measureTime = Float64Array.from(song.measures, (m) => m.time);
  const measureLabel = song.measures.map((m) => toPersianDigits(m.number));

  // ── Colours, read from the CSS tokens (defined once in base.css) ─
  const base = HANDS.map((h) => cssColor(`--hand-${h}`, h === 'right' ? '#2f80ed' : '#f2891d'));
  const colors = {
    fill: base,
    lit: base.map((c) => lighten(c, 0.35)),
    brass: cssColor('--brass', '#cda65a'),
    ink: cssColor('--ink', '#f3e7d9'),
  };

  // ── Geometry ─────────────────────────────────────────────────────
  let width = 0;
  let height = 0;
  let dpr = 1;
  let pxPerSecond = 120;
  let keyX = new Float64Array(128);
  let keyW = new Float64Array(128);
  let octaveLines = [];

  function resize() {
    // Cap the pixel ratio: 2× is already sharp, 3× just costs fill rate on phones.
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    // About 2.6 s of music visible, but keep the speed readable on short and tall screens.
    pxPerSecond = Math.min(260, Math.max(90, height / 2.6));
  }

  function setLayout(layout) {
    keyX = layout.x;
    keyW = layout.width;
    octaveLines = [];
    for (let m = 24; m <= 108; m += 12) octaveLines.push(m);
  }

  // ── Drawing ──────────────────────────────────────────────────────
  // ctx.roundRect is missing before iOS 16 / Firefox 112.
  const roundRect = ctx.roundRect
    ? (x, y, w, h, r) => ctx.roundRect(x, y, w, h, r)
    : (x, y, w, h, r) => {
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      };

  const font = '600 11px Vazirmatn, system-ui, sans-serif';
  const noteFont = '700 11px Vazirmatn, system-ui, sans-serif';

  function drawLanes() {
    ctx.fillStyle = 'rgb(255 255 255 / 0.045)';
    for (const m of octaveLines) {
      const x = keyX[m];
      if (x > -1 && x < width + 1) ctx.fillRect(Math.round(x), 0, 1, height);
    }
  }

  function drawMeasures(from, to, base, loop) {
    ctx.font = font;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    let i = lowerBound(measureTime, from - 1e-6);
    for (; i < measureTime.length && measureTime[i] <= to + 1e-6; i++) {
      const y = height - (measureTime[i] - base) * pxPerSecond;
      const isLoopEdge = loop && (Math.abs(measureTime[i] - loop.start) < 1e-6 || Math.abs(measureTime[i] - loop.end) < 1e-6);
      ctx.fillStyle = isLoopEdge ? colors.brass : 'rgb(243 231 217 / 0.13)';
      ctx.fillRect(0, Math.round(y), width, isLoopEdge ? 2 : 1);
      ctx.fillStyle = isLoopEdge ? colors.brass : 'rgb(243 231 217 / 0.45)';
      ctx.fillText(measureLabel[i], 6, Math.round(y) - 2);
    }
  }

  function drawNotes(now, from, to, base, muted, isPrimary) {
    ctx.font = noteFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const first = lowerBound(start, from - maxDuration);
    for (let i = first; i < count && start[i] < to; i++) {
      if (end[i] <= from) continue;
      const m = midi[i];
      const black = isBlack(m);
      const inset = black ? 0.5 : 1.5;
      const x = keyX[m] + inset;
      const w = keyW[m] - inset * 2;
      if (x + w < 0 || x > width) continue;

      // The bottom edge is exact; a 1px gap at the top separates repeated notes.
      const bottom = height - (start[i] - base) * pxPerSecond;
      const top = Math.min(bottom - 3, height - (end[i] - base) * pxPerSecond + 1);
      const h = bottom - top;
      const sounding = isPrimary && start[i] <= now && now < end[i];
      const handIndex = hand[i];

      ctx.globalAlpha = muted[HANDS[handIndex]] ? 0.3 : 1;
      ctx.fillStyle = sounding ? colors.lit[handIndex] : colors.fill[handIndex];
      ctx.beginPath();
      roundRect(x, top, w, h, Math.min(6, w / 3, h / 2));
      ctx.fill();

      // Note name on the bar, once there is room for it.
      const visibleBottom = Math.min(top + h, height);
      if (w >= 16 && visibleBottom - top >= 22) {
        ctx.fillStyle = 'rgb(255 255 255 / 0.92)';
        ctx.fillText(label[i], x + w / 2, visibleBottom - 4);
      }
    }
    ctx.globalAlpha = 1;
  }

  function segment(now, from, to, base, clipTop, clipBottom, muted, loop, isPrimary) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, clipTop, width, clipBottom - clipTop);
    ctx.clip();
    drawMeasures(from, to, base, loop);
    drawNotes(now, from, to, base, muted, isPrimary);
    ctx.restore();
  }

  /**
   * Draw the view at song time `now`.
   * @param {object} options { muted: { right?, left? }, loop: { start, end } | null }
   */
  function render(now, { muted = {}, loop = null } = {}) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawLanes();

    const windowEnd = now + height / pxPerSecond;
    if (loop && now < loop.end && windowEnd > loop.end) {
      // Looping: above the loop's end, show what comes next — the loop's start.
      const seam = height - (loop.end - now) * pxPerSecond;
      segment(now, now, loop.end, now, seam, height, muted, loop, true);
      const base = loop.start - (loop.end - now);
      segment(now, loop.start, loop.start + (windowEnd - loop.end), base, 0, seam, muted, loop, false);
    } else {
      segment(now, now, windowEnd, now, 0, height, muted, loop, true);
    }

    // The "now" line the bars land on.
    ctx.fillStyle = 'rgb(205 166 90 / 0.5)';
    ctx.fillRect(0, height - 2, width, 2);
  }

  /** Calls fn(midi, hand) for every note sounding at `now`. */
  function forEachSounding(now, fn) {
    for (let i = lowerBound(start, now - maxDuration); i < count && start[i] <= now; i++) {
      if (end[i] > now) fn(midi[i], HANDS[hand[i]]);
    }
  }

  return {
    resize,
    setLayout,
    render,
    forEachSounding,
    get pxPerSecond() {
      return pxPerSecond;
    },
  };
}
