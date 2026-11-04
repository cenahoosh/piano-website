// player.html?song=<name> — practice view: the sheet music (sight reading) or the
// falling notes (waterfall) above the keyboard. Without a song it goes to the catalog.

import * as piano from './piano.js';
import { createKeyboard } from './keyboard.js';
import { createFallingNotes } from './falling-notes.js';
import { createSheetView } from './sheet-view.js';
import { createSongPlayer, LEAD_IN } from './song-player.js';
import { setupStartOverlay } from './start-overlay.js';
import { MIDDLE_C, noteToMidi, toPersianDigits } from './notes.js';

const $ = (id) => document.getElementById(id);

function showMessage(text) {
  $('player').hidden = true;
  $('message-text').textContent = text;
  $('message').hidden = false;
}

// ─────────────────────────────────────────────────────────────────────
// Practice view
// ─────────────────────────────────────────────────────────────────────

async function loadSong(id) {
  if (!/^[\p{L}\p{N}_.-]+$/u.test(id) || id.includes('..')) return null;
  const response = await fetch(`songs/${encodeURIComponent(id)}.json`, { cache: 'no-cache' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(response.statusText);
  return response.json();
}

async function showPlayer(id) {
  let song;
  try {
    song = await loadSong(id);
  } catch (err) {
    console.error(err);
    return showMessage('آهنگ بارگذاری نشد. اتصال اینترنت را بررسی کنید و صفحه را دوباره باز کنید.');
  }
  if (!song) return showMessage(`آهنگی با نام «${id}» پیدا نشد.`);

  const main = $('player');
  main.hidden = false;
  document.title = `${song.title} | تمرین پیانو`;
  $('song-title').textContent = song.title;
  $('song-composer').textContent = song.composer ?? '';

  // ── Above the keyboard: sheet music or falling notes ─────────────
  const stage = document.createElement('div');
  stage.className = 'stage';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'نت‌هایی که روی کیبورد می‌افتند');
  canvas.setAttribute('role', 'img');
  const sheetBox = document.createElement('div');
  stage.append(sheetBox, canvas);

  const view = createFallingNotes(canvas, song);
  const sheet = createSheetView(sheetBox, song, {
    onSeek(measureIndex) {
      player?.seek(song.measures[measureIndex].time);
      requestFrame();
    },
    onLayout: () => requestFrame(),
  });
  sheet.setClock(() => currentTime());
  let player = null; // created once audio is unlocked
  const muted = { right: false, left: false };

  const handForKey = (note) => (noteToMidi(note) < MIDDLE_C ? 'left' : 'right');
  const keyboard = createKeyboard($('keyboard'), {
    stage,
    onViewChange: updateLayout,
    // Students can play along on the screen keyboard.
    onKeyDown(note) {
      const hand = handForKey(note);
      piano.noteOn(note, { hand, notify: false });
      keyboard.light(note, hand);
    },
    onKeyUp(note) {
      piano.noteOff(note, { notify: false });
      keyboard.unlight(note);
    },
  });

  function updateLayout() {
    view.setLayout(keyboard.layout(canvas));
    requestFrame();
  }
  // Watch the canvas itself: it is hidden (0×0) while the sheet view is shown and
  // must re-measure when it appears.
  const resizeObserver = new ResizeObserver(() => {
    view.resize();
    updateLayout();
  });
  resizeObserver.observe(stage);
  resizeObserver.observe(canvas);
  view.resize();

  // Show the song's range of keys as large as the screen allows.
  const pitches = song.notes.map((n) => noteToMidi(n.note));
  if (pitches.length) keyboard.fitRange(Math.min(...pitches), Math.max(...pitches));

  // ── Frame loop: one clock (the Transport) for picture and keys ───
  let lit = new Map();
  let next = new Map();
  function syncKeys(now) {
    next.clear();
    view.forEachSounding(now, (midi, hand) => next.set(midi, hand));
    for (const [midi, hand] of lit) if (next.get(midi) !== hand) keyboard.unlight(midi);
    for (const [midi, hand] of next) if (lit.get(midi) !== hand) keyboard.light(midi, hand);
    [lit, next] = [next, lit];
  }

  let shownMeasure = -1;
  function updatePosition(now) {
    let index = 0;
    while (index + 1 < song.measures.length && song.measures[index + 1].time <= now + 1e-6) index++;
    if (index === shownMeasure) return;
    shownMeasure = index;
    $('position').textContent = `میزان ${toPersianDigits(song.measures[index].number)}`;
  }

  let rafId = 0;
  let scrubbing = false;
  const currentTime = () => (player ? player.position() : -LEAD_IN);

  function frame() {
    rafId = 0;
    let now = currentTime();
    if (player?.isPlaying && !player.loop && now >= song.duration + 0.3) {
      player.pause();
      updatePlayButton();
      now = currentTime();
    }
    if (activeView === 'sheet') sheet.render(now, { loop: player?.loop ?? null });
    else view.render(now, { muted, loop: player?.loop ?? null });
    syncKeys(now);
    updatePosition(now);
    if (player?.isPlaying || scrubbing) rafId = requestAnimationFrame(frame);
  }
  function requestFrame() {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  // ── Sheet / waterfall switch (remembered on this device) ─────────
  const VIEW_KEY = 'piano.practiceView';
  let activeView = 'sheet';
  try {
    if (localStorage.getItem(VIEW_KEY) === 'waterfall') activeView = 'waterfall';
  } catch {
    // Storage blocked (private mode): start with the sheet.
  }
  function setView(name, { remember = true } = {}) {
    activeView = name;
    stage.dataset.view = name;
    $('view-sheet').setAttribute('aria-pressed', String(name === 'sheet'));
    $('view-waterfall').setAttribute('aria-pressed', String(name === 'waterfall'));
    if (remember) {
      try {
        localStorage.setItem(VIEW_KEY, name);
      } catch {
        // Not remembered; nothing else depends on it.
      }
    }
    requestFrame();
  }
  $('view-sheet').addEventListener('click', () => setView('sheet'));
  $('view-waterfall').addEventListener('click', () => setView('waterfall'));
  setView(activeView, { remember: false });
  // A song without a usable score still works in the waterfall.
  sheet.ready.then(requestFrame, () => {
    if (activeView === 'sheet') setView('waterfall', { remember: false });
  });

  // ── Toolbar ──────────────────────────────────────────────────────
  const playButton = $('play');
  function updatePlayButton() {
    const playing = Boolean(player?.isPlaying);
    playButton.classList.toggle('is-playing', playing);
    playButton.setAttribute('aria-label', playing ? 'مکث' : 'پخش');
  }
  function togglePlay() {
    if (!player) return;
    if (player.isPlaying) player.pause();
    else player.play();
    updatePlayButton();
    requestFrame();
  }
  playButton.addEventListener('click', togglePlay);

  $('rewind').addEventListener('click', () => {
    player?.rewind();
    updatePlayButton();
    requestFrame();
  });

  const toggle = (button, on) => button.setAttribute('aria-pressed', String(on));
  const pressed = (button) => button.getAttribute('aria-pressed') === 'true';

  $('metronome').addEventListener('click', (e) => {
    const on = !pressed(e.currentTarget);
    toggle(e.currentTarget, on);
    player?.setMetronome(on);
  });

  for (const hand of ['right', 'left']) {
    $(`hand-${hand}`).addEventListener('click', (e) => {
      const on = !pressed(e.currentTarget);
      toggle(e.currentTarget, on);
      muted[hand] = !on;
      player?.setHand(hand, on);
      requestFrame();
    });
  }

  const tempo = $('tempo');
  tempo.addEventListener('input', () => {
    $('tempo-value').textContent = `${toPersianDigits(tempo.value)}٪`;
    player?.setRate(Number(tempo.value) / 100);
  });

  // ── Loop a range of measures ─────────────────────────────────────
  const loopButton = $('loop');
  const loopFrom = $('loop-from');
  const loopTo = $('loop-to');
  const seenNumbers = new Map();
  song.measures.forEach((m, i) => {
    const pass = (seenNumbers.get(m.number) ?? 0) + 1;
    seenNumbers.set(m.number, pass);
    const text = toPersianDigits(m.number) + (pass > 1 ? ` (بار ${toPersianDigits(pass)})` : '');
    loopFrom.add(new Option(text, i));
    loopTo.add(new Option(text, i));
  });

  function applyLoop() {
    let from = Number(loopFrom.value);
    let to = Number(loopTo.value);
    if (to < from) {
      to = from;
      loopTo.value = String(to);
    }
    const end = song.measures[to + 1]?.time ?? song.duration;
    player?.setLoop({ start: song.measures[from].time, end });
    requestFrame();
  }
  loopFrom.addEventListener('change', () => {
    if (Number(loopTo.value) < Number(loopFrom.value)) loopTo.value = loopFrom.value;
    applyLoop();
  });
  loopTo.addEventListener('change', () => {
    if (Number(loopTo.value) < Number(loopFrom.value)) loopFrom.value = loopTo.value;
    applyLoop();
  });
  loopButton.addEventListener('click', () => {
    const on = !pressed(loopButton);
    toggle(loopButton, on);
    $('loop-bar').hidden = !on;
    if (on) {
      // Start with the measure being played and the next one.
      const current = Math.max(0, shownMeasure);
      loopFrom.value = String(current);
      loopTo.value = String(Math.min(current + 1, song.measures.length - 1));
      applyLoop();
    } else {
      player?.setLoop(null);
      requestFrame();
    }
  });

  // ── Drag on the notes: up/down moves through the song, sideways scrolls the keys
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!player) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, time: player.position(), axis: null, resume: player.isPlaying };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (drag.axis === 'y') {
        player.pause();
        scrubbing = true;
        requestFrame();
      }
    }
    if (drag.axis === 'x') {
      keyboard.scrollBy(-(e.clientX - (drag.lastX ?? drag.x)));
      drag.lastX = e.clientX;
    } else {
      // Dragging the notes down brings later notes onto the keys.
      player.seek(drag.time + dy / view.pxPerSecond);
    }
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.axis === 'y') {
      scrubbing = false;
      if (drag.resume) player.play();
      updatePlayButton();
      requestFrame();
    }
    drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!player) return;
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) keyboard.scrollBy(e.deltaX);
      else {
        player.seek(player.position() + e.deltaY / view.pxPerSecond);
        requestFrame();
      }
    },
    { passive: false },
  );

  // Space bar plays/pauses (unless a control has focus and handles it itself).
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || e.target.closest?.('button, input, select, a')) return;
    e.preventDefault();
    togglePlay();
  });

  // Pause when the page is hidden (phone locked, app switched).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && player?.isPlaying) {
      player.pause();
      updatePlayButton();
    }
  });

  await document.fonts?.ready;
  requestFrame();

  // ── Audio ────────────────────────────────────────────────────────
  const start = $('start');
  start.hidden = false;
  await setupStartOverlay({ button: start, note: $('start-note'), onReady() {} });
  player = createSongPlayer(song);
  player.setRate(Number(tempo.value) / 100);
  player.setMetronome(pressed($('metronome')));
  for (const hand of ['right', 'left']) player.setHand(hand, !muted[hand]);
  if (pressed(loopButton)) applyLoop();
  main.inert = false;
  playButton.focus({ preventScroll: true });
  requestFrame();

  // For automated checks and debugging in the console.
  window.__player = { song, player, view, sheet, keyboard, redraw: requestFrame, setView };
}

const songId = new URLSearchParams(location.search).get('song');
if (songId) showPlayer(songId);
else location.replace('index.html');
