#!/usr/bin/env node
// Converts the teacher's MuseScore exports into the JSON songs the site plays.
//
//   node scripts/convert.mjs
//
// Reads every .musicxml / .xml / .mxl file in songs-src/ and writes:
//   songs/<name>.json      one file per song (see "Output" below)
//   songs/<name>.musicxml  the score itself (unzipped), for the sheet-music view
//   songs/index.json       [{ id, file, title, composer, level, duration }]
// and removes the generated files of scores that were deleted from songs-src/.
//
// No dependencies: runs on a plain Node.js (18+) install.
//
// What it understands
//   - Ties (merged into one longer note), chords, rests, dotted and tuplet notes,
//     several voices per staff (<backup>/<forward>), pickup measures.
//   - Tempo: <sound tempo> and metronome marks, including changes mid-piece.
//   - Dynamics (pp … ff, <sound dynamics>, per-note dynamics) → velocity.
//   - Repeats are written out in playing order: repeat signs (with times="n"),
//     1st/2nd endings, D.C., D.S., Fine and To Coda. After a D.C./D.S. the
//     repeats are not taken again and the last ending is played (the usual convention).
//   - Hand: staff 1 = right, staff 2 = left.
//   - Grace notes are skipped (they have no written length).
//
// Song metadata
//   title     MuseScore "Title" (work-title / movement-title / title text)
//   composer  MuseScore "Composer"
//   level     a <miscellaneous-field name="level"> in the file, or a sidecar file
//             songs-src/<name>.meta.json such as { "level": 2 } — the sidecar can
//             also override "title" and "composer".
//
// Output (songs/<name>.json)
//   { title, composer, level, source, score, duration, tempo, timeSignature,
//     tempos:   [{ time, bpm }],
//     measures: [{ number, index, time, timeSignature }],   // in playing order
//     notes:    [{ note, time, duration, hand, velocity, measure, beat }] }
//   - time / duration in seconds at the written tempo.
//   - measure: the measure number printed in the score (repeats repeat it).
//   - measures[].index: 0-based position of that measure in the written score,
//     so a repeated measure points back to the same printed measure.
//   - score: file name of the score copy next to the JSON.
//   - beat: 1-based position in the measure, counted in the time signature's
//     beat unit (quarters in 4/4, eighths in 6/8). 2.5 = halfway through beat 2.

import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSIONS = ['.musicxml', '.xml', '.mxl'];
const DEFAULT_TEMPO = 120; // MusicXML's default when a score has no tempo
const DEFAULT_VELOCITY = 80; // mf, on the MIDI 0–127 scale
const EPS = 1e-6;

// ─────────────────────────────────────────────────────────────────────
// Minimal XML reader (elements, attributes, text — enough for MusicXML)
// ─────────────────────────────────────────────────────────────────────

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[e] ?? match;
  });
}

export function parseXml(src) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const find = (needle, from) => {
    const at = src.indexOf(needle, from);
    if (at === -1) throw new Error(`Malformed XML: missing "${needle}"`);
    return at;
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      top().text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      i = find('-->', lt) + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = find(']]>', lt);
      top().text += src.slice(lt + 9, end);
      i = end + 3;
    } else if (src.startsWith('<?', lt)) {
      i = find('?>', lt) + 2;
    } else if (src.startsWith('<!', lt)) {
      // <!DOCTYPE …> possibly with an [internal subset]
      let j = lt + 2;
      for (let depth = 0; j < src.length; j++) {
        if (src[j] === '[') depth++;
        else if (src[j] === ']') depth--;
        else if (src[j] === '>' && depth === 0) break;
      }
      i = j + 1;
    } else if (src[lt + 1] === '/') {
      const end = find('>', lt);
      const name = src.slice(lt + 2, end).trim();
      const node = stack.pop();
      if (stack.length === 0 || node.name !== name) {
        throw new Error(`Malformed XML: </${name}> does not match <${node?.name}>`);
      }
      i = end + 1;
    } else {
      let j = lt + 1;
      for (let quote = null; j < src.length; j++) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= src.length) throw new Error('Malformed XML: unterminated tag');
      let body = src.slice(lt + 1, j);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const name = /^[^\s/>]+/.exec(body)[0];
      const node = { name, attrs: {}, children: [], text: '' };
      const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      for (let a; (a = attrRe.exec(body.slice(name.length))); ) {
        node.attrs[a[1]] = decodeEntities(a[2] ?? a[3]);
      }
      top().children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new Error(`Malformed XML: <${top().name}> is never closed`);
  return root;
}

const kids = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
const kid = (node, name) => node?.children.find((c) => c.name === name);
function text(node, name) {
  const el = name === undefined ? node : kid(node, name);
  return el ? el.text.trim() : undefined;
}
function number(node, name) {
  const t = text(node, name);
  if (t === undefined || t === '') return undefined;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : undefined;
}

// ─────────────────────────────────────────────────────────────────────
// Reading files (.musicxml / .xml / compressed .mxl)
// ─────────────────────────────────────────────────────────────────────

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  const s = buf.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Returns Map<path, Buffer> of every file in a zip archive. */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a valid .mxl (zip) file');
  const files = new Map();
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt .mxl: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;

    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + size);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`Unsupported compression in .mxl (method ${method})`);
  }
  return files;
}

export async function readScoreText(file) {
  const buf = await readFile(file);
  if (path.extname(file).toLowerCase() !== '.mxl') return decodeText(buf);

  const files = unzip(buf);
  const container = files.get('META-INF/container.xml');
  let rootPath;
  if (container) {
    const rootfiles = kids(kid(kid(parseXml(decodeText(container)), 'container'), 'rootfiles'), 'rootfile');
    const main =
      rootfiles.find((r) => !r.attrs['media-type'] || r.attrs['media-type'].includes('musicxml')) ?? rootfiles[0];
    rootPath = main?.attrs['full-path'];
  }
  rootPath ??= [...files.keys()].find((n) => !n.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(n));
  if (!rootPath || !files.has(rootPath)) throw new Error('No MusicXML score found inside the .mxl file');
  return decodeText(files.get(rootPath));
}

// ─────────────────────────────────────────────────────────────────────
// Parsing measures (in written order)
// ─────────────────────────────────────────────────────────────────────

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const TYPE_QUARTERS = {
  maxima: 32, long: 16, breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5,
  '16th': 1 / 4, '32nd': 1 / 8, '64th': 1 / 16, '128th': 1 / 32, '256th': 1 / 64,
};
// MIDI velocities MuseScore uses for each marking.
const DYNAMIC_LEVELS = {
  pppppp: 4, ppppp: 8, pppp: 12, ppp: 16, pp: 33, p: 49, mp: 64,
  mf: 80, f: 96, ff: 112, fff: 126, ffff: 127, fffff: 127, ffffff: 127,
};
// Accents: apply only to the notes they are written on.
const DYNAMIC_ACCENTS = { sf: 112, sfz: 112, sffz: 127, fz: 112, rf: 100, rfz: 100, sfp: 112, sfpp: 112, fp: 96, pf: 49, sfzp: 112 };

const midiToName = (midi) => NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);

function parseEndingNumbers(value = '') {
  const numbers = [];
  for (const part of value.split(/[,\s]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) for (let n = +range[1]; n <= +range[2]; n++) numbers.push(n);
    else if (/^\d+$/.test(part)) numbers.push(Number(part));
  }
  return numbers;
}

function parseTimeSignature(time) {
  if (!time || kid(time, 'senza-misura')) return null;
  // Composite signatures such as 3+2/8 or 2/4 + 3/8.
  const beats = kids(time, 'beats').map((b) => b.text.trim().split('+').reduce((s, x) => s + Number(x), 0));
  const types = kids(time, 'beat-type').map((b) => Number(b.text.trim()));
  if (!beats.length || !types.length || beats.some(Number.isNaN) || types.some(Number.isNaN)) return null;
  const quarters = beats.reduce((sum, b, i) => sum + (b * 4) / (types[i] ?? types[0]), 0);
  const beatType = Math.max(...types);
  return {
    label: beats.map((b, i) => `${kids(time, 'beats')[i].text.trim()}/${types[i] ?? types[0]}`).join('+'),
    quarters,
    beatType,
  };
}

function parsePart(part, partIndex, warn) {
  const state = {
    divisions: 1,
    time: { label: '4/4', quarters: 4, beatType: 4 },
    transpose: 0,
  };
  let graceNotes = 0;

  const measures = kids(part, 'measure').map((m, index) => {
    const measure = {
      index,
      number: m.attrs.number,
      implicit: m.attrs.implicit === 'yes',
      notes: [],
      tempos: [],
      dynamics: [],
      jumps: {},
      forwardRepeat: false,
      backwardRepeat: false,
      repeatTimes: 2,
      endingStart: null,
      endingStop: null,
    };
    const toQ = (divs) => divs / state.divisions;
    let cursor = 0;
    let maxCursor = 0;
    let lastStart = 0;
    let measureRests = []; // whole-measure rests without a written duration

    const handleSound = (sound, at, staff) => {
      const a = sound.attrs;
      if (a.tempo !== undefined) {
        const bpm = parseFloat(a.tempo);
        if (bpm > 0) measure.tempos.push({ q: at, bpm });
      }
      if (a.dynamics !== undefined) {
        const percent = parseFloat(a.dynamics);
        if (percent >= 0) measure.dynamics.push({ q: at, staff, velocity: (percent / 100) * 90, accent: false });
      }
      if (a.dacapo === 'yes') measure.jumps.dacapo = true;
      if (a.dalsegno !== undefined) measure.jumps.dalsegno = a.dalsegno || 'segno';
      if (a.segno !== undefined) measure.jumps.segno = a.segno || 'segno';
      if (a.coda !== undefined) measure.jumps.coda = a.coda || 'coda';
      if (a.tocoda !== undefined) measure.jumps.tocoda = a.tocoda || 'coda';
      if (a.fine !== undefined) measure.jumps.fine = true;
    };

    for (const el of m.children) {
      switch (el.name) {
        case 'attributes': {
          const divisions = number(el, 'divisions');
          if (divisions > 0) state.divisions = divisions;
          const time = parseTimeSignature(kid(el, 'time'));
          if (time) state.time = time;
          const transpose = kid(el, 'transpose');
          if (transpose) {
            state.transpose = (number(transpose, 'chromatic') ?? 0) + 12 * (number(transpose, 'octave-change') ?? 0);
          }
          break;
        }

        case 'note': {
          if (kid(el, 'grace')) {
            graceNotes++;
            break;
          }
          const isChord = Boolean(kid(el, 'chord'));
          const rest = kid(el, 'rest');
          let duration;
          if (number(el, 'duration') !== undefined) {
            duration = toQ(number(el, 'duration'));
          } else if (TYPE_QUARTERS[text(el, 'type')] !== undefined) {
            // No <duration>: work it out from the note value, dots and tuplet ratio.
            const base = TYPE_QUARTERS[text(el, 'type')];
            const dots = kids(el, 'dot').length;
            duration = base * (2 - 1 / 2 ** dots);
            const tm = kid(el, 'time-modification');
            if (tm) duration *= (number(tm, 'normal-notes') ?? 1) / (number(tm, 'actual-notes') ?? 1);
          } else if (rest?.attrs.measure === 'yes') {
            duration = null; // filled in below once the time signature is known
          } else {
            duration = 0;
          }

          const start = isChord ? lastStart : cursor;
          if (!isChord) {
            lastStart = cursor;
            if (duration === null) measureRests.push(cursor);
            else cursor += duration;
            maxCursor = Math.max(maxCursor, cursor);
          }

          const pitch = kid(el, 'pitch');
          if (rest || kid(el, 'cue') || !pitch || !duration) break; // silent

          const midi =
            (number(pitch, 'octave') + 1) * 12 +
            STEP[text(pitch, 'step')] +
            Math.round(number(pitch, 'alter') ?? 0) +
            state.transpose;
          if (!Number.isFinite(midi)) {
            warn(`measure ${measure.number}: skipped a note with an unreadable pitch`);
            break;
          }
          const tieTypes = [
            ...kids(el, 'tie').map((t) => t.attrs.type),
            ...kids(kid(el, 'notations'), 'tied').map((t) => t.attrs.type),
          ];
          const noteDynamics = el.attrs.dynamics !== undefined ? parseFloat(el.attrs.dynamics) : undefined;
          measure.notes.push({
            midi,
            q: start,
            duration,
            part: partIndex,
            staff: number(el, 'staff') ?? 1,
            tieStart: tieTypes.includes('start') || tieTypes.includes('continue'),
            tieStop: tieTypes.includes('stop') || tieTypes.includes('continue'),
            velocity: noteDynamics >= 0 ? (noteDynamics / 100) * 90 : undefined,
          });
          break;
        }

        case 'backup':
          cursor = Math.max(0, cursor - toQ(number(el, 'duration') ?? 0));
          break;

        case 'forward':
          cursor += toQ(number(el, 'duration') ?? 0);
          maxCursor = Math.max(maxCursor, cursor);
          break;

        case 'direction': {
          const offset = kid(el, 'offset');
          const at = cursor + (offset?.attrs.sound === 'yes' ? toQ(number(offset) ?? 0) : 0);
          const staff = number(el, 'staff') ?? null;
          const sound = kid(el, 'sound');
          if (sound) handleSound(sound, at, staff);
          for (const type of kids(el, 'direction-type')) {
            const metronome = kid(type, 'metronome');
            if (metronome && sound?.attrs.tempo === undefined) {
              const unit = TYPE_QUARTERS[text(metronome, 'beat-unit')];
              const perMinute = parseFloat((text(metronome, 'per-minute') ?? '').replace(/[^\d.]/g, ''));
              if (unit && perMinute > 0) {
                const dots = kids(metronome, 'beat-unit-dot').length;
                measure.tempos.push({ q: at, bpm: perMinute * unit * (2 - 1 / 2 ** dots) });
              }
            }
            const dynamics = kid(type, 'dynamics');
            if (dynamics && sound?.attrs.dynamics === undefined) {
              for (const mark of dynamics.children) {
                if (DYNAMIC_LEVELS[mark.name]) {
                  measure.dynamics.push({ q: at, staff, velocity: DYNAMIC_LEVELS[mark.name], accent: false });
                } else if (DYNAMIC_ACCENTS[mark.name]) {
                  measure.dynamics.push({ q: at, staff, velocity: DYNAMIC_ACCENTS[mark.name], accent: true });
                }
              }
            }
          }
          break;
        }

        case 'sound':
          handleSound(el, cursor, null);
          break;

        case 'barline': {
          const repeat = kid(el, 'repeat');
          if (repeat?.attrs.direction === 'forward') measure.forwardRepeat = true;
          if (repeat?.attrs.direction === 'backward') {
            measure.backwardRepeat = true;
            measure.repeatTimes = Math.max(1, parseInt(repeat.attrs.times, 10) || 2);
          }
          const ending = kid(el, 'ending');
          if (ending) {
            const numbers = parseEndingNumbers(ending.attrs.number);
            if (ending.attrs.type === 'start') measure.endingStart = numbers;
            else measure.endingStop = numbers;
          }
          const sound = kid(el, 'sound');
          if (sound) handleSound(sound, cursor, null);
          break;
        }
      }
    }

    // A whole-measure rest with no written length lasts the whole measure.
    if (measureRests.length) maxCursor = Math.max(maxCursor, state.time.quarters);
    measure.time = state.time;
    measure.length = maxCursor > EPS ? maxCursor : state.time.quarters;
    return measure;
  });

  if (graceNotes) warn(`skipped ${graceNotes} grace note${graceNotes > 1 ? 's' : ''}`);
  return measures;
}

// ─────────────────────────────────────────────────────────────────────
// Repeats → playing order
// ─────────────────────────────────────────────────────────────────────

function endOfEnding(measures, start) {
  for (let j = start; j < measures.length; j++) if (measures[j].endingStop) return j;
  return start;
}

function isLastEnding(measures, start) {
  return !measures[endOfEnding(measures, start) + 1]?.endingStart;
}

/** Returns measure indices in the order they are played. */
export function expandRepeats(measures, warn = () => {}) {
  const order = [];
  const segnos = new Map();
  const codas = new Map();
  measures.forEach((m, i) => {
    if (m.jumps.segno) segnos.set(m.jumps.segno, i);
    if (m.jumps.coda) codas.set(m.jumps.coda, i);
  });

  const limit = measures.length * 50 + 1000;
  const repeatsTaken = new Map();
  let i = 0;
  let repeatStart = 0;
  let pass = 1;
  let jumpedBack = false; // true once a D.C. / D.S. has been followed
  let arrivedByRepeat = false;

  while (i < measures.length) {
    if (order.length > limit) throw new Error('Repeat structure never ends — check the repeat signs and jumps');
    const m = measures[i];

    if (m.forwardRepeat && !arrivedByRepeat) {
      repeatStart = i;
      pass = 1;
    }
    arrivedByRepeat = false;

    if (m.endingStart) {
      const plays = jumpedBack ? isLastEnding(measures, i) : m.endingStart.includes(pass);
      if (!plays) {
        i = endOfEnding(measures, i) + 1;
        continue;
      }
    }

    order.push(i);

    if (jumpedBack && m.jumps.fine) break;

    if (m.backwardRepeat && !jumpedBack) {
      const taken = repeatsTaken.get(i) ?? 0;
      if (taken < m.repeatTimes - 1) {
        repeatsTaken.set(i, taken + 1);
        pass++;
        i = repeatStart;
        arrivedByRepeat = true;
        continue;
      }
    }
    if (m.backwardRepeat || m.endingStop) {
      // This repeated section is done; a later repeat sign goes back to here.
      repeatStart = i + 1;
      pass = 1;
    }

    if (jumpedBack && m.jumps.tocoda) {
      if (codas.has(m.jumps.tocoda)) {
        i = codas.get(m.jumps.tocoda);
        continue;
      }
      warn(`measure ${m.number}: "To Coda" has no matching Coda sign`);
    }

    if (!jumpedBack && (m.jumps.dacapo || m.jumps.dalsegno)) {
      jumpedBack = true;
      let target = 0;
      if (m.jumps.dalsegno) {
        if (segnos.has(m.jumps.dalsegno)) target = segnos.get(m.jumps.dalsegno);
        else warn(`measure ${m.number}: D.S. has no matching Segno sign; going back to the start`);
      }
      i = target;
      repeatStart = target;
      pass = 1;
      arrivedByRepeat = true;
      continue;
    }

    i++;
  }
  return order;
}

// ─────────────────────────────────────────────────────────────────────
// Timeline: ties, dynamics, tempo → seconds
// ─────────────────────────────────────────────────────────────────────

function makeClock(tempos) {
  const points = [];
  const initial = tempos.find((t) => t.q <= EPS)?.bpm ?? tempos[0]?.bpm ?? DEFAULT_TEMPO;
  let q = 0;
  let sec = 0;
  let bpm = initial;
  points.push({ q, sec, bpm });
  for (const t of tempos) {
    if (t.q <= EPS) {
      bpm = t.bpm;
      points[0].bpm = bpm;
      continue;
    }
    if (Math.abs(t.bpm - bpm) < EPS) continue; // e.g. the same marking passed again on a repeat
    sec +=((t.q - q) * 60) / bpm;
    q = t.q;
    bpm = t.bpm;
    points.push({ q, sec, bpm });
  }
  return {
    points,
    seconds(at) {
      let p = points[0];
      for (const candidate of points) if (candidate.q <= at + EPS) p = candidate;
      return p.sec + ((at - p.q) * 60) / p.bpm;
    },
  };
}

const round = (value, places = 3) => {
  const f = 10 ** places;
  return Math.round(value * f) / f || 0;
};

function measureNumber(raw, fallback) {
  if (raw !== undefined && /^-?\d+$/.test(raw)) return Number(raw);
  return raw ?? fallback;
}

function readMetadata(score) {
  const work = kid(score, 'work');
  const identification = kid(score, 'identification');
  const credit = (type) =>
    kids(score, 'credit')
      .find((c) => kids(c, 'credit-type').some((t) => text(t) === type))
      ?.children.filter((c) => c.name === 'credit-words')
      .map((c) => c.text.trim())
      .join(' ') || undefined;
  const title = text(work, 'work-title') || text(score, 'movement-title') || credit('title');
  const composer =
    kids(identification, 'creator')
      .find((c) => c.attrs.type === 'composer')
      ?.text.trim() || credit('composer');
  const levelField = kids(kid(identification, 'miscellaneous'), 'miscellaneous-field').find(
    (f) => f.attrs.name?.toLowerCase() === 'level',
  );
  return { title, composer, level: parseLevel(levelField?.text.trim()) };
}

function parseLevel(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return /^\d+$/.test(String(value).trim()) ? Number(value) : value;
}

/**
 * Convert one MusicXML document to a song object.
 * @returns {{ song: object, warnings: string[] }}
 */
export function convertMusicXml(xml, { source = 'score.musicxml', meta = {} } = {}) {
  const warnings = [];
  const warn = (message) => warnings.push(message);

  const doc = parseXml(xml);
  if (kid(doc, 'score-timewise')) {
    throw new Error('This is a "timewise" MusicXML file; export it from MuseScore again (MuseScore writes "partwise")');
  }
  const score = kid(doc, 'score-partwise');
  if (!score) throw new Error('Not a MusicXML score (no <score-partwise> element)');

  const parts = kids(score, 'part').map((part, p) => parsePart(part, p, warn));
  if (!parts.length || !parts[0].length) throw new Error('The score has no measures');
  if (parts.some((p) => p.length !== parts[0].length)) warn('parts have different numbers of measures');

  // Merge parts measure by measure. Repeat signs and jumps come from the first part.
  const measures = parts[0].map((first, i) => ({
    ...first,
    length: Math.max(...parts.map((p) => p[i]?.length ?? 0)),
    notes: parts.flatMap((p) => p[i]?.notes ?? []),
    tempos: parts.flatMap((p) => p[i]?.tempos ?? []),
    dynamics: parts.flatMap((p, partIndex) => (p[i]?.dynamics ?? []).map((d) => ({ ...d, part: partIndex }))),
  }));
  const staves = new Set(measures.flatMap((m) => m.notes.map((n) => n.staff)));
  if ([...staves].some((s) => s > 2)) warn('notes on staff 3 or higher are treated as left hand');

  // Lay the measures out in playing order.
  const order = expandRepeats(measures, warn);
  const pickup = measures[0].implicit && measures[0].length < measures[0].time.quarters - EPS;
  let position = 0;
  const instances = order.map((index) => {
    const m = measures[index];
    const instance = {
      m,
      start: position,
      // In a pickup bar, the first note falls on a late beat (e.g. beat 4 of 4/4).
      beatShift: index === 0 && pickup ? m.time.quarters - m.length : 0,
    };
    position += m.length;
    return instance;
  });
  const totalQ = position;

  const tempos = instances
    .flatMap(({ m, start }) => m.tempos.map((t) => ({ q: start + t.q, bpm: t.bpm })))
    .sort((a, b) => a.q - b.q);
  if (!tempos.length) warn(`no tempo marking; using ♩ = ${DEFAULT_TEMPO}`);
  const clock = makeClock(tempos);

  const dynamics = instances
    .flatMap(({ m, start }) => m.dynamics.map((d) => ({ ...d, q: start + d.q })))
    .sort((a, b) => a.q - b.q);

  let notes = instances
    .flatMap(({ m, start, beatShift }) =>
      m.notes.map((n) => ({
        ...n,
        q: start + n.q,
        end: start + n.q + n.duration,
        measure: measureNumber(m.number, m.index + 1),
        beat: 1 + ((n.q + beatShift) * m.time.beatType) / 4,
      })),
    )
    .sort((a, b) => a.q - b.q || a.midi - b.midi);

  // Ties: fold each tied continuation into the note it continues.
  const open = new Map();
  let unmatchedTies = 0;
  notes = notes.filter((n) => {
    const key = `${n.part}:${n.staff}:${n.midi}`;
    const held = open.get(key);
    if (n.tieStop && held && Math.abs(held.end - n.q) < EPS) {
      held.end = n.end;
      if (!n.tieStart) open.delete(key);
      return false;
    }
    if (n.tieStop && !n.tieStart) unmatchedTies++;
    if (n.tieStart) open.set(key, n);
    else open.delete(key);
    return true;
  });
  if (unmatchedTies) warn(`${unmatchedTies} tie${unmatchedTies > 1 ? 's' : ''} had no note to connect to`);

  // Dynamics: the latest marking for that staff (or for the whole part) applies.
  for (const n of notes) {
    if (n.velocity !== undefined) continue;
    let velocity = DEFAULT_VELOCITY;
    let accent;
    for (const d of dynamics) {
      if (d.q > n.q + EPS) break;
      if (d.part !== n.part || (d.staff !== null && d.staff !== n.staff)) continue;
      if (!d.accent) velocity = d.velocity;
      else if (Math.abs(d.q - n.q) < EPS) accent = d.velocity;
    }
    n.velocity = accent ?? velocity;
  }

  const songNotes = notes.map((n) => {
    const time = clock.seconds(n.q);
    return {
      note: midiToName(n.midi),
      time: round(time),
      duration: round(clock.seconds(n.end) - time),
      hand: n.staff >= 2 ? 'left' : 'right',
      velocity: round(Math.min(1, Math.max(0.05, n.velocity / 127)), 2),
      measure: n.measure,
      beat: round(n.beat),
    };
  });

  const metadata = readMetadata(score);
  const title = meta.title ?? metadata.title ?? path.basename(source, path.extname(source));
  const composer = meta.composer ?? metadata.composer ?? null;
  const level = parseLevel(meta.level) ?? metadata.level ?? null;
  if (!metadata.title && !meta.title) warn('no title in the score; using the file name');
  if (level === null) warn('no level set (add a <name>.meta.json next to the score, e.g. { "level": 1 })');

  const lastNoteEnd = Math.max(0, ...songNotes.map((n) => n.time + n.duration));
  const song = {
    title,
    composer,
    level,
    source,
    duration: round(Math.max(clock.seconds(totalQ), lastNoteEnd)),
    tempo: round(clock.points[0].bpm, 2),
    timeSignature: measures[0].time.label,
    tempos: clock.points.map((p) => ({ time: round(p.sec), bpm: round(p.bpm, 2) })),
    measures: instances.map(({ m, start }) => ({
      number: measureNumber(m.number, m.index + 1),
      index: m.index,
      time: round(clock.seconds(start)),
      timeSignature: m.time.label,
    })),
    notes: songNotes,
  };
  return { song, warnings };
}

// ─────────────────────────────────────────────────────────────────────
// Writing files
// ─────────────────────────────────────────────────────────────────────

/** JSON with one array item per line, so song diffs stay readable. */
export function formatSong(song) {
  const entries = Object.entries(song).map(([key, value]) => {
    if (Array.isArray(value) && value.length && typeof value[0] === 'object') {
      const items = value.map((v) => `    ${JSON.stringify(v)}`).join(',\n');
      return `  ${JSON.stringify(key)}: [\n${items}\n  ]`;
    }
    return `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  });
  return `{\n${entries.join(',\n')}\n}\n`;
}

async function readSidecar(file) {
  const sidecar = file.slice(0, -path.extname(file).length) + '.meta.json';
  try {
    return JSON.parse(await readFile(sidecar, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`${path.basename(sidecar)} is not valid JSON: ${err.message}`);
  }
}

/**
 * Convert every score in srcDir. Writes songs and, if all succeed, index.json.
 * @returns {Promise<{ converted: number, failed: number }>}
 */
export async function convertAll({ srcDir = path.join(ROOT, 'songs-src'), outDir = path.join(ROOT, 'songs'), log = console } = {}) {
  await mkdir(outDir, { recursive: true });
  const files = (await readdir(srcDir))
    .filter((f) => SOURCE_EXTENSIONS.includes(path.extname(f).toLowerCase()) && !f.endsWith('.meta.json'))
    .sort();

  const index = [];
  const seen = new Map();
  let failed = 0;

  for (const file of files) {
    const id = path.basename(file, path.extname(file));
    if (seen.has(id)) {
      log.error(`✗ ${file}: skipped — ${seen.get(id)} has the same name`);
      failed++;
      continue;
    }
    seen.set(id, file);
    try {
      const fullPath = path.join(srcDir, file);
      const [xml, meta] = await Promise.all([readScoreText(fullPath), readSidecar(fullPath)]);
      const { song, warnings } = convertMusicXml(xml, { source: file, meta });
      const { title, composer, level, source, ...rest } = song;
      const output = { title, composer, level, source, score: `${id}.musicxml`, ...rest };
      await writeFile(path.join(outDir, `${id}.json`), formatSong(output));
      await writeFile(path.join(outDir, `${id}.musicxml`), xml);
      index.push({ id, file: `${id}.json`, title: song.title, composer: song.composer, level: song.level, duration: song.duration });
      log.log(`✓ ${file} → songs/${id}.json  (${song.notes.length} notes, ${song.measures.length} measures, ${song.duration} s)`);
      for (const w of warnings) log.log(`    ⚠ ${w}`);
    } catch (err) {
      failed++;
      log.error(`✗ ${file}: ${err.message}`);
    }
  }

  if (failed) {
    log.error(`\n${failed} file(s) failed; songs/index.json was not updated.`);
  } else {
    index.sort(
      (a, b) =>
        (a.level ?? Infinity) - (b.level ?? Infinity) ||
        String(a.level ?? '').localeCompare(String(b.level ?? '')) ||
        String(a.title).localeCompare(String(b.title), 'fa'),
    );
    await writeFile(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
    log.log(`\nWrote songs/index.json (${index.length} song${index.length === 1 ? '' : 's'}).`);

    // A score deleted from songs-src/ takes its generated files with it.
    for (const file of await readdir(outDir)) {
      const match = /^(.+)\.(json|musicxml)$/.exec(file);
      if (!match || file === 'index.json' || seen.has(match[1])) continue;
      await unlink(path.join(outDir, file));
      log.log(`Removed songs/${file} (its score is no longer in songs-src/).`);
    }
  }
  return { converted: index.length, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { failed } = await convertAll();
  process.exitCode = failed ? 1 : 0;
}
