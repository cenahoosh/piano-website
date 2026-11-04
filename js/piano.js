// Piano sound: a Tone.js Sampler over the self-hosted Salamander Grand Piano samples.
//
// Usage:
//   import * as piano from './piano.js';
//   piano.preload();                 // any time: fetches Tone.js and the samples
//   button.onclick = () => piano.start();   // must run inside a tap/click
//   piano.playNote('C4', 0.5, piano.now() + 0.1, { hand: 'right' });
//
// Visual sync: `piano.events` fires "noteon" / "noteoff" (detail: { note, hand })
// at the moment each note actually starts and stops sounding.

import { noteToMidi } from './notes.js';

const TONE_URL = new URL('./vendor/Tone.js', import.meta.url).href;
const SAMPLES_URL = new URL('../assets/piano/', import.meta.url).href;

// Salamander is sampled every minor third: A, C, D#, F#. The Sampler pitch-shifts
// the notes in between from the nearest sample.
function sampleMap() {
  const urls = { A0: 'A0.mp3' };
  for (let octave = 1; octave <= 7; octave++) {
    urls[`C${octave}`] = `C${octave}.mp3`;
    urls[`D#${octave}`] = `Ds${octave}.mp3`;
    urls[`F#${octave}`] = `Fs${octave}.mp3`;
    urls[`A${octave}`] = `A${octave}.mp3`;
  }
  urls.C8 = 'C8.mp3';
  return urls;
}

// How long a note takes to fade once the key is let go. On a real piano the dampers
// stop the mid range quickly, the heavy bass strings take longer, and the top ~1.5
// octaves have no dampers at all, so they ring on.
function releaseFor(midi) {
  if (midi >= 89) return 2.5; // F6 and up: undamped strings
  if (midi < 48) return 1.4; // below C3
  return 1.0;
}

export const events = new EventTarget();

let Tone = null;
let sampler = null;
let tonePromise = null;
let samplesPromise = null;

function loadToneScript() {
  if (globalThis.Tone) return Promise.resolve(globalThis.Tone);
  tonePromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TONE_URL;
    script.onload = () => resolve(globalThis.Tone);
    script.onerror = () => {
      tonePromise = null;
      reject(new Error('Tone.js could not be loaded'));
    };
    document.head.append(script);
  });
  return tonePromise;
}

/** Resolves once Tone.js is loaded, so `start()` can be called synchronously in a tap. */
export async function loadEngine() {
  Tone = await loadToneScript();
  return Tone;
}

/** Fetch Tone.js and decode every sample. Safe to call before the user has tapped. */
export function preload() {
  samplesPromise ??= loadEngine().then(
    () =>
      new Promise((resolve, reject) => {
        const limiter = new Tone.Limiter(-1).toDestination();
        sampler = new Tone.Sampler({
          urls: sampleMap(),
          baseUrl: SAMPLES_URL,
          attack: 0,
          release: 1,
          curve: 'exponential',
          volume: -4,
          onload: () => resolve(),
          onerror: (err) => {
            samplesPromise = null;
            reject(err);
          },
        }).connect(limiter);
      }),
  );
  return samplesPromise;
}

export function isReady() {
  return Boolean(sampler?.loaded);
}

/**
 * Unlock audio. Call this directly from a click/tap handler (browsers only allow
 * sound after a user gesture). Requires `loadEngine()` to have finished.
 */
export function start() {
  if (!Tone) throw new Error('Call loadEngine() before start()');
  return Tone.start();
}

/** Current audio-clock time in seconds, for scheduling with playNote. */
export function now() {
  return Tone ? Tone.now() : 0;
}

function emit(type, note, hand, time) {
  const fire = () => events.dispatchEvent(new CustomEvent(type, { detail: { note, hand } }));
  // Tone.Draw runs the callback on the animation frame closest to `time`,
  // so key highlights line up with what you hear.
  if (time === undefined) fire();
  else Tone.getDraw().schedule(fire, time);
}

function prepare(note) {
  const midi = noteToMidi(note);
  if (Number.isNaN(midi)) throw new Error(`Unknown note name: ${note}`);
  sampler.release = releaseFor(midi); // read by the Sampler when the note starts
}

/**
 * Play one note.
 * @param {string} note       Scientific pitch name, e.g. "C4" or "F#3".
 * @param {number} duration   Seconds the key is held down.
 * @param {number} [time]     Audio-clock time to start (see `now()`); defaults to now.
 * @param {object} [options]  { velocity: 0–1 (default 0.8), hand: "right" | "left" }
 */
export function playNote(note, duration, time, { velocity = 0.8, hand = 'right' } = {}) {
  if (!isReady()) return;
  const start = time ?? Tone.now();
  prepare(note);
  sampler.triggerAttackRelease(note, duration, start, velocity);
  emit('noteon', note, hand, start);
  emit('noteoff', note, hand, start + duration);
}

/** Press and hold a key (for live playing). Pair with noteOff. */
export function noteOn(note, { velocity = 0.8, hand = 'right' } = {}) {
  if (!isReady()) return;
  prepare(note);
  sampler.triggerAttack(note, Tone.now(), velocity);
  emit('noteon', note, hand);
}

/** Let go of a key started with noteOn. */
export function noteOff(note, { hand = 'right' } = {}) {
  if (!isReady()) return;
  sampler.triggerRelease(note, Tone.now());
  emit('noteoff', note, hand);
}
