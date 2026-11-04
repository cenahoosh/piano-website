// 88-key on-screen piano keyboard (A0–C8), drawn with HTML/CSS.
//
// const kb = createKeyboard(container, {
//   onKeyDown: (note) => …,   // a key was pressed (touch, mouse or computer keyboard)
//   onKeyUp:   (note) => …,   // that key was let go
// });
// kb.light('C4', 'right');  kb.unlight('C4');   // show which notes are sounding
//
// The keyboard always runs low → high, left → right, even on an RTL page.
// Swiping across keys plays them (glissando), so scrolling is done with the
// mini-map strip above the keys (or a trackpad / mouse wheel on desktop).

import { MIDI_MIN, MIDI_MAX, MIDDLE_C, isBlack, midiToNote, noteToMidi, persianNoteName } from './notes.js';

// Black keys are not centred on the gap between white keys: C#/D# lean apart,
// as do F#/A#. Offsets are in white-key widths, relative to that gap.
const BLACK_OFFSET = { 1: -0.1, 3: 0.1, 6: -0.12, 8: 0, 10: 0.12 };
const BLACK_WIDTH = 0.6; // in white-key widths (must match --bk-ratio in keyboard.css)
const ZOOM_LEVELS = [0.6, 0.8, 1, 1.25, 1.6];

// Computer-keyboard layout for desktop practice: A row = white keys, Q row = black keys.
const COMPUTER_KEYS = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7,
  KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16,
};

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function buildKeys(container, { withLabels }) {
  const keys = new Map();
  let whiteIndex = 0;
  for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
    const black = isBlack(midi);
    const key = el('div', black ? 'key key--black' : 'key key--white', { 'data-midi': midi });
    if (black) {
      const x = whiteIndex + BLACK_OFFSET[midi % 12] - BLACK_WIDTH / 2;
      key.style.setProperty('--x', x.toFixed(3));
    } else {
      key.style.setProperty('--x', whiteIndex);
      whiteIndex++;
      if (withLabels && midi % 12 === 0) {
        const { name, octave } = persianNoteName(midi);
        const label = el('span', 'key__label');
        label.textContent = name + octave;
        if (midi === MIDDLE_C) key.classList.add('key--middle-c');
        key.append(label);
      }
    }
    container.append(key);
    keys.set(midi, key);
  }
  return keys;
}

export function createKeyboard(root, { onKeyDown = () => {}, onKeyUp = () => {}, computerKeyboard = true } = {}) {
  root.classList.add('keyboard');
  root.setAttribute('dir', 'ltr');
  root.innerHTML = '';

  // ── Mini-map + zoom bar ────────────────────────────────────────────
  const bar = el('div', 'keyboard__bar');
  const zoomOut = el('button', 'keyboard__zoom', { type: 'button', 'aria-label': 'کوچک‌نمایی کیبورد' });
  zoomOut.textContent = '−';
  const zoomIn = el('button', 'keyboard__zoom', { type: 'button', 'aria-label': 'بزرگ‌نمایی کیبورد' });
  zoomIn.textContent = '+';
  const map = el('div', 'keyboard__map', {
    role: 'slider',
    tabindex: '0',
    'aria-label': 'جابه‌جایی روی کیبورد',
    'aria-valuemin': MIDI_MIN,
    'aria-valuemax': MIDI_MAX,
  });
  const mapKeys = el('div', 'keyboard__map-keys');
  const mapWindow = el('div', 'keyboard__map-window');
  map.append(mapKeys, mapWindow);
  bar.append(zoomOut, map, zoomIn);

  // ── Keys ───────────────────────────────────────────────────────────
  const scroller = el('div', 'keyboard__scroller');
  const keysEl = el('div', 'keyboard__keys', { role: 'group', 'aria-label': 'کیبورد پیانو' });
  scroller.append(keysEl);
  root.append(bar, scroller);

  const keys = buildKeys(keysEl, { withLabels: true });
  const miniKeys = buildKeys(mapKeys, { withLabels: false });

  // ── Lighting (which notes are sounding) ────────────────────────────
  const litCount = new Map();
  function setLit(midi, hand) {
    for (const node of [keys.get(midi), miniKeys.get(midi)]) {
      if (!node) continue;
      if (hand) node.dataset.hand = hand;
      else delete node.dataset.hand;
    }
  }
  function light(note, hand = 'right') {
    const midi = typeof note === 'number' ? note : noteToMidi(note);
    if (!keys.has(midi)) return;
    litCount.set(midi, (litCount.get(midi) ?? 0) + 1);
    setLit(midi, hand);
  }
  function unlight(note) {
    const midi = typeof note === 'number' ? note : noteToMidi(note);
    const count = (litCount.get(midi) ?? 0) - 1;
    if (count > 0) return litCount.set(midi, count);
    litCount.delete(midi);
    setLit(midi, null);
  }
  function clear() {
    for (const midi of litCount.keys()) setLit(midi, null);
    litCount.clear();
  }

  // ── Touch / mouse playing ──────────────────────────────────────────
  // pointerId → midi currently held by that finger/mouse. Sliding a finger onto a
  // neighbouring key releases the old one and presses the new one.
  const held = new Map();
  const heldCount = new Map();

  function press(midi) {
    heldCount.set(midi, (heldCount.get(midi) ?? 0) + 1);
    keys.get(midi).classList.add('is-down');
    onKeyDown(midiToNote(midi));
  }
  function release(midi) {
    const count = (heldCount.get(midi) ?? 1) - 1;
    if (count > 0) heldCount.set(midi, count);
    else {
      heldCount.delete(midi);
      keys.get(midi).classList.remove('is-down');
    }
    onKeyUp(midiToNote(midi));
  }
  function keyAt(x, y) {
    const target = document.elementFromPoint(x, y)?.closest('.key');
    return target && keysEl.contains(target) ? Number(target.dataset.midi) : null;
  }

  keysEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const midi = keyAt(e.clientX, e.clientY);
    if (midi === null) return;
    e.preventDefault();
    keysEl.setPointerCapture(e.pointerId); // keep receiving moves after leaving a key
    held.set(e.pointerId, midi);
    press(midi);
  });
  keysEl.addEventListener('pointermove', (e) => {
    if (!held.has(e.pointerId)) return;
    const midi = keyAt(e.clientX, e.clientY);
    const previous = held.get(e.pointerId);
    if (midi === previous) return;
    if (previous !== null) release(previous);
    held.set(e.pointerId, midi);
    if (midi !== null) press(midi);
  });
  const endPointer = (e) => {
    if (!held.has(e.pointerId)) return;
    const midi = held.get(e.pointerId);
    held.delete(e.pointerId);
    if (midi !== null) release(midi);
  };
  keysEl.addEventListener('pointerup', endPointer);
  keysEl.addEventListener('pointercancel', endPointer);
  keysEl.addEventListener('lostpointercapture', endPointer);
  keysEl.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press menu on phones

  // ── Computer keyboard (desktop) ────────────────────────────────────
  const computerHeld = new Map();
  function onComputerKey(e) {
    const offset = COMPUTER_KEYS[e.code];
    if (offset === undefined || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.type === 'keydown') {
      const midi = MIDDLE_C + offset;
      computerHeld.set(e.code, midi);
      press(midi);
    } else if (computerHeld.has(e.code)) {
      release(computerHeld.get(e.code));
      computerHeld.delete(e.code);
    }
  }
  if (computerKeyboard) {
    window.addEventListener('keydown', onComputerKey);
    window.addEventListener('keyup', onComputerKey);
  }

  // ── Scrolling, mini-map and zoom ───────────────────────────────────
  let centerFraction = null; // which part of the keyboard is in the middle of the view
  let zoomIndex = ZOOM_LEVELS.indexOf(1);

  function keyCenterFraction(midi) {
    const key = keys.get(midi);
    return (key.offsetLeft + key.offsetWidth / 2) / keysEl.offsetWidth;
  }
  function scrollToFraction(fraction, behavior = 'auto') {
    const left = fraction * keysEl.offsetWidth - scroller.clientWidth / 2;
    scroller.scrollTo({ left, behavior });
    centerFraction = fraction;
  }
  function centerOn(note, { smooth = false } = {}) {
    const midi = typeof note === 'number' ? note : noteToMidi(note);
    if (keys.has(midi)) scrollToFraction(keyCenterFraction(midi), smooth ? 'smooth' : 'auto');
  }

  function updateMap() {
    const total = keysEl.offsetWidth;
    const view = scroller.clientWidth;
    const fits = total <= view + 1;
    root.classList.toggle('keyboard--fits', fits);
    zoomOut.disabled = fits || zoomIndex === 0;
    zoomIn.disabled = zoomIndex === ZOOM_LEVELS.length - 1;
    const start = Math.max(0, scroller.scrollLeft) / total;
    const width = Math.min(1, view / total);
    mapWindow.style.left = `${start * 100}%`;
    mapWindow.style.width = `${width * 100}%`;
    // Report the visible range to screen readers as the note in the middle.
    const middle = start + width / 2;
    let nearest = MIDDLE_C;
    let best = Infinity;
    for (const [midi, key] of keys) {
      if (isBlack(midi)) continue;
      const d = Math.abs((key.offsetLeft + key.offsetWidth / 2) / total - middle);
      if (d < best) [best, nearest] = [d, midi];
    }
    const { name, octave } = persianNoteName(nearest);
    map.setAttribute('aria-valuenow', nearest);
    map.setAttribute('aria-valuetext', `وسط کیبورد: ${name} ${octave}`);
  }

  scroller.addEventListener(
    'scroll',
    () => {
      centerFraction = (scroller.scrollLeft + scroller.clientWidth / 2) / keysEl.offsetWidth;
      updateMap();
    },
    { passive: true },
  );
  // A plain mouse wheel scrolls the keyboard sideways.
  scroller.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || root.classList.contains('keyboard--fits')) return;
      e.preventDefault();
      scroller.scrollLeft += e.deltaY;
    },
    { passive: false },
  );

  // Drag (or tap) on the mini-map to move the view there.
  function mapPointer(e) {
    const rect = map.getBoundingClientRect();
    scrollToFraction(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
  }
  map.addEventListener('pointerdown', (e) => {
    map.setPointerCapture(e.pointerId);
    mapPointer(e);
  });
  map.addEventListener('pointermove', (e) => {
    if (map.hasPointerCapture(e.pointerId)) mapPointer(e);
  });
  map.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const octave = keys.get(MIDDLE_C + 12).offsetLeft - keys.get(MIDDLE_C).offsetLeft;
    scroller.scrollBy({ left: step * octave, behavior: 'smooth' });
  });

  function setZoom(index) {
    const keep = centerFraction ?? keyCenterFraction(MIDDLE_C);
    zoomIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index));
    root.style.setProperty('--zoom', ZOOM_LEVELS[zoomIndex]);
    scrollToFraction(keep);
    updateMap();
  }
  zoomOut.addEventListener('click', () => setZoom(zoomIndex - 1));
  zoomIn.addEventListener('click', () => setZoom(zoomIndex + 1));

  // Rotating the phone changes the key size; keep the same notes in the middle.
  const resizeObserver = new ResizeObserver(() => {
    if (centerFraction === null) centerOn(MIDDLE_C);
    else scrollToFraction(centerFraction);
    updateMap();
  });
  resizeObserver.observe(scroller);

  centerOn(MIDDLE_C);
  updateMap();

  return {
    light,
    unlight,
    clear,
    centerOn,
    destroy() {
      resizeObserver.disconnect();
      window.removeEventListener('keydown', onComputerKey);
      window.removeEventListener('keyup', onComputerKey);
      root.innerHTML = '';
    },
  };
}
