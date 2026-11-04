// Note-name helpers shared by the keyboard, the piano and (later) the song player.
// Notes use scientific pitch names such as "C4", "F#3" or "Bb2".

const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SOLFEGE = { C: 'دو', D: 'ر', E: 'می', F: 'فا', G: 'سل', A: 'لا', B: 'سی' };
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Lowest and highest key on an 88-key piano (A0 and C8). */
export const MIDI_MIN = 21;
export const MIDI_MAX = 108;
export const MIDDLE_C = 60;

/** "F#3" → 54. Returns NaN for anything that is not a note name. */
export function noteToMidi(note) {
  const m = /^([A-Ga-g])(#{1,2}|b{1,2})?(-?\d)$/.exec(String(note).trim());
  if (!m) return NaN;
  const [, letter, accidental = '', octave] = m;
  const shift = accidental.startsWith('#') ? accidental.length : -accidental.length;
  return (Number(octave) + 1) * 12 + PITCH_CLASS[letter.toUpperCase()] + shift;
}

/** 54 → "F#3" (always spelled with sharps). */
export function midiToNote(midi) {
  return SHARP_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

export function isBlack(midi) {
  return [1, 3, 6, 8, 10].includes(midi % 12);
}

export function toPersianDigits(value) {
  return String(value).replace(/\d/g, (d) => PERSIAN_DIGITS[d]);
}

/** 54 → { name: "فا دیز", octave: "۳" } — solfege names used by Iranian piano teachers. */
export function persianNoteName(midi) {
  const spelled = midiToNote(midi);
  const name = SOLFEGE[spelled[0]] + (spelled[1] === '#' ? ' دیز' : '');
  return { name, octave: toPersianDigits(Math.floor(midi / 12) - 1) };
}
