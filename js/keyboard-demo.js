// keyboard.html: wires the on-screen keyboard to the piano sound.

import * as piano from './piano.js';
import { createKeyboard } from './keyboard.js';
import { MIDDLE_C, noteToMidi, persianNoteName } from './notes.js';
import { setupStartOverlay } from './start-overlay.js';

const demo = document.getElementById('demo');
const readoutName = document.getElementById('readout-name');
const readoutDetail = document.getElementById('readout-detail');
const scaleButton = document.getElementById('play-scale');
const chordButton = document.getElementById('play-chords');

// Keys you play yourself: below middle C counts as left hand, middle C and up as right.
const handFor = (note) => (noteToMidi(note) < MIDDLE_C ? 'left' : 'right');

const keyboard = createKeyboard(document.getElementById('keyboard'), {
  onKeyDown: (note) => piano.noteOn(note, { hand: handFor(note), velocity: 0.75 }),
  onKeyUp: (note) => piano.noteOff(note, { hand: handFor(note) }),
});

function showNote(note, hand) {
  const { name, octave } = persianNoteName(noteToMidi(note));
  readoutName.textContent = name;
  const octaveEl = document.createElement('span');
  octaveEl.className = 'readout__octave';
  octaveEl.textContent = octave;
  readoutName.append(octaveEl);
  readoutName.dataset.hand = hand;
  readoutDetail.textContent = note;
  readoutDetail.dir = 'ltr';
}

piano.events.addEventListener('noteon', ({ detail }) => {
  keyboard.light(detail.note, detail.hand);
  showNote(detail.note, detail.hand);
});
piano.events.addEventListener('noteoff', ({ detail }) => keyboard.unlight(detail.note));

// ── Demos ───────────────────────────────────────────────────────────

const C_MAJOR_UP = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5'];

function scaleNotes() {
  const step = 0.42;
  const notes = [...C_MAJOR_UP, ...C_MAJOR_UP.slice(0, -1).reverse()];
  return notes.map((note, i) => ({
    note,
    time: i * step,
    duration: i === notes.length - 1 ? step * 3 : step * 0.92,
    hand: 'right',
    velocity: 0.7,
  }));
}

// I – IV – V – I in C major: bass in the left hand, triads in the right.
function chordNotes() {
  const chords = [
    { left: ['C3', 'G3'], right: ['C4', 'E4', 'G4'] },
    { left: ['F2', 'C3'], right: ['C4', 'F4', 'A4'] },
    { left: ['G2', 'D3'], right: ['B3', 'D4', 'G4'] },
    { left: ['C3', 'G3'], right: ['C4', 'E4', 'G4', 'C5'] },
  ];
  const beat = 1.1;
  return chords.flatMap((chord, i) => {
    const duration = i === chords.length - 1 ? beat * 2.2 : beat * 0.95;
    const time = i * beat;
    return [
      ...chord.left.map((note) => ({ note, time, duration, hand: 'left', velocity: 0.6 })),
      ...chord.right.map((note) => ({ note, time, duration, hand: 'right', velocity: 0.68 })),
    ];
  });
}

let playing = false;

function play(notes, centerNote) {
  if (playing || !piano.isReady()) return;
  playing = true;
  for (const button of [scaleButton, chordButton]) {
    button.disabled = true;
    button.textContent = 'در حال پخش…';
  }
  keyboard.centerOn(centerNote, { smooth: true });

  const start = piano.now() + 0.15;
  for (const n of notes) piano.playNote(n.note, n.duration, start + n.time, n);

  const end = Math.max(...notes.map((n) => n.time + n.duration));
  setTimeout(() => {
    playing = false;
    for (const button of [scaleButton, chordButton]) {
      button.disabled = false;
      button.textContent = button.dataset.label;
    }
  }, (end + 0.3) * 1000);
}

scaleButton.addEventListener('click', () => play(scaleNotes(), 'F#4'));
chordButton.addEventListener('click', () => play(chordNotes(), 'C4'));

// ── "Tap to start" ──────────────────────────────────────────────────

setupStartOverlay({
  button: document.getElementById('start'),
  note: document.getElementById('start-note'),
  onReady() {
    demo.inert = false;
    scaleButton.focus({ preventScroll: true });
  },
});
