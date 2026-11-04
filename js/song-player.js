// Plays a converted song (songs/<name>.json) on the Tone.js Transport.
//
// The Transport is the only clock. Song time (seconds at the written tempo) is
// mapped onto Transport ticks with bpm = 60 × speed, so one "beat" is one second
// of the song: changing the speed changes bpm, and every scheduled note — and the
// animation, which reads the same ticks — follows without drifting.
//
//   const player = createSongPlayer(song);
//   player.play(); player.pause(); player.seek(12.5); player.setRate(0.75);
//   player.position()   // song seconds currently coming out of the speaker

import * as piano from './piano.js';

const PPQ = 960; // ticks per song-second (≈1 ms resolution)

/** Seconds of falling notes before the first note sounds. */
export const LEAD_IN = 2;

function parseTimeSignature(label = '4/4') {
  const [beats, type] = label.split('/');
  return { beats: beats.split('+').reduce((sum, b) => sum + Number(b), 0), type: Number(type) || 4 };
}

/** Metronome clicks: one per beat (per dotted quarter in 6/8, 9/8, 12/8). */
export function beatTimes(song) {
  const clicks = [];
  const tempoAt = (t) => {
    let bpm = song.tempo || 120;
    for (const change of song.tempos ?? []) if (change.time <= t + 1e-6) bpm = change.bpm;
    return bpm;
  };
  song.measures.forEach((measure, i) => {
    const end = song.measures[i + 1]?.time ?? song.duration;
    const length = end - measure.time;
    if (length <= 0) return;
    const { beats, type } = parseTimeSignature(measure.timeSignature);
    const compound = type === 8 && beats % 3 === 0 && beats > 3;
    const quarter = 60 / tempoAt(measure.time);
    const beatLength = compound ? quarter * 1.5 : (quarter * 4) / type;
    const fullCount = compound ? beats / 3 : beats;
    const count = Math.max(1, Math.round(length / beatLength));
    const spacing = length / count;
    // A short (pickup) measure counts its last beats, so it gets no downbeat.
    const firstBeat = fullCount - count;
    for (let b = 0; b < count; b++) {
      clicks.push({ time: measure.time + b * spacing, accent: firstBeat + b === 0 });
    }
  });
  return clicks;
}

export function createSongPlayer(song) {
  const Tone = piano.getTone();
  const transport = Tone.getTransport();
  transport.stop();
  transport.cancel(0);
  transport.loop = false;
  transport.PPQ = PPQ;
  transport.bpm.value = 60;

  const toTicks = (t) => Math.round((t + LEAD_IN) * PPQ);
  const fromTicks = (ticks) => ticks / PPQ - LEAD_IN;
  const at = (t) => `${toTicks(t)}i`;

  const state = {
    rate: 1,
    hands: { right: true, left: true },
    metronome: false,
    loop: null, // { start, end } in song seconds
  };
  let syncedAt = 0; // audio time at which the last start/seek takes effect

  // ── Notes ────────────────────────────────────────────────────────
  for (const n of song.notes) {
    transport.schedule((time) => {
      if (!state.hands[n.hand]) return;
      piano.playNote(n.note, n.duration / state.rate, time, { velocity: n.velocity, hand: n.hand, notify: false });
    }, at(n.time));
  }

  // ── Metronome ────────────────────────────────────────────────────
  const click = new Tone.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.02 },
    volume: -8,
  }).toDestination();
  for (const beat of beatTimes(song)) {
    transport.schedule((time) => {
      if (state.metronome) click.triggerAttackRelease(beat.accent ? 'E6' : 'A5', 0.03, time, beat.accent ? 1 : 0.6);
    }, at(beat.time));
  }

  // Where playback enters a loop. A loop from the very start keeps the lead-in.
  const loopEntry = (loop) => (loop.start <= 1e-3 ? -LEAD_IN : loop.start);
  const outsideLoop = (loop, pos) => pos < loopEntry(loop) - 1e-3 || pos >= loop.end;

  function clampTime(t) {
    return Math.min(Math.max(t, -LEAD_IN), song.duration);
  }

  function seek(t) {
    piano.releaseAll();
    transport.ticks = toTicks(clampTime(t));
    syncedAt = Tone.now();
  }

  return {
    get rate() {
      return state.rate;
    },
    get isPlaying() {
      return transport.state === 'started';
    },
    get loop() {
      return state.loop;
    },

    /**
     * The song time being heard right now. Reads the Transport's ticks at the
     * audio clock minus the output latency, so the picture matches the sound.
     */
    position() {
      if (transport.state !== 'started') return fromTicks(transport.ticks);
      // Starts and seeks take effect one look-ahead from now; before that moment
      // the Transport still reports the old position, so never read earlier.
      const heard = Math.max(Tone.immediate() - piano.outputLatency(), syncedAt);
      return fromTicks(transport.getTicksAtTime(heard));
    },

    play() {
      if (transport.state === 'started') return;
      const pos = fromTicks(transport.ticks);
      if (state.loop && outsideLoop(state.loop, pos)) seek(loopEntry(state.loop));
      else if (!state.loop && pos >= song.duration - 1e-3) seek(-LEAD_IN);
      transport.start();
      syncedAt = Tone.now();
    },

    pause() {
      transport.pause();
      piano.releaseAll();
    },

    /** Back to the start (or to the start of the loop). */
    rewind() {
      transport.pause();
      seek(state.loop ? loopEntry(state.loop) : -LEAD_IN);
    },

    seek,

    setRate(rate) {
      state.rate = rate;
      transport.bpm.value = 60 * rate;
    },

    setHand(hand, on) {
      state.hands[hand] = on;
    },

    setMetronome(on) {
      state.metronome = on;
    },

    /** Repeat song time start…end (seconds); null turns looping off. */
    setLoop(range) {
      state.loop = range;
      if (!range) {
        transport.loop = false;
        return;
      }
      transport.setLoopPoints(at(range.start), at(range.end));
      transport.loop = true;
      if (outsideLoop(range, this.position())) seek(loopEntry(range));
    },

    dispose() {
      transport.stop();
      transport.cancel(0);
      click.dispose();
    },
  };
}
