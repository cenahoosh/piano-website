// Tests for the song converter.  Run: node --test scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';
import { convertMusicXml, convertAll, readScoreText, parseXml } from './convert.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ODE = path.join(ROOT, 'songs-src', 'ode-to-joy.musicxml');

// ── Tiny MusicXML builders ─────────────────────────────────────────────

const STEP_RE = /^([A-G])(#|b)?(\d)$/;
function n(pitch, duration, { staff = 1, chord = false, tie = [], type, dots = 0, voice = 1, attrs = '' } = {}) {
  const [, step, acc, octave] = STEP_RE.exec(pitch);
  const alter = acc ? `<alter>${acc === '#' ? 1 : -1}</alter>` : '';
  return (
    `<note${attrs}>${chord ? '<chord/>' : ''}<pitch><step>${step}</step>${alter}<octave>${octave}</octave></pitch>` +
    (duration === null ? '' : `<duration>${duration}</duration>`) +
    tie.map((t) => `<tie type="${t}"/>`).join('') +
    `<voice>${voice}</voice>${type ? `<type>${type}</type>` : ''}${'<dot/>'.repeat(dots)}<staff>${staff}</staff></note>`
  );
}
const rest = (duration, staff = 1) => `<note><rest/><duration>${duration}</duration><staff>${staff}</staff></note>`;
const backup = (d) => `<backup><duration>${d}</duration></backup>`;
const tempo = (bpm) => `<direction><direction-type><words>tempo</words></direction-type><sound tempo="${bpm}"/></direction>`;
const repeatEnd = (times) =>
  `<barline location="right"><repeat direction="backward"${times ? ` times="${times}"` : ''}/></barline>`;
const repeatStart = '<barline location="left"><repeat direction="forward"/></barline>';
const ending = (num, type) =>
  `<barline location="${type === 'start' ? 'left' : 'right'}"><ending number="${num}" type="${type}"/></barline>`;
const sound = (attrs) => `<sound ${attrs}/>`;
const fourQuarters = (p) => [p, p, p, p].map((x) => n(x, 1)).join('');

/** measures: array of XML strings (or { number, implicit, xml }). */
function score(measures, { divisions = 1, time = [4, 4], header = '' } = {}) {
  const attributes = `<attributes><divisions>${divisions}</divisions><time><beats>${time[0]}</beats><beat-type>${time[1]}</beat-type></time><staves>2</staves></attributes>`;
  const body = measures
    .map((m, i) => {
      const { number = String(i + 1), implicit = false, xml } = typeof m === 'string' ? { xml: m } : m;
      return `<measure number="${number}"${implicit ? ' implicit="yes"' : ''}>${i === 0 ? attributes : ''}${xml}</measure>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">${header}<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">${body}</part></score-partwise>`;
}

const convert = (xml, meta) => convertMusicXml(xml, { source: 'test.musicxml', meta });
const measureOrder = (song) => song.measures.map((m) => m.number);
const pick = (song, keys = ['note', 'time', 'duration']) =>
  song.notes.map((note) => Object.fromEntries(keys.map((k) => [k, note[k]])));

// ── The sample song ────────────────────────────────────────────────────

test('Ode to Joy: repeats, ties, chords, dotted notes, rests, tempo, metadata', async () => {
  const { song, warnings } = convertMusicXml(await readScoreText(ODE), { source: 'ode-to-joy.musicxml' });
  assert.deepEqual(warnings, []);
  assert.equal(song.title, 'سرود شادی');
  assert.equal(song.composer, 'لودویگ فان بتهوون');
  assert.equal(song.level, 1);
  assert.equal(song.tempo, 100);
  assert.deepEqual(song.tempos, [{ time: 0, bpm: 100 }]);
  assert.deepEqual(measureOrder(song), [1, 2, 3, 4, 1, 2, 3, 5]);
  assert.equal(song.duration, 19.2); // 8 bars × 4 beats × 0.6 s
  assert.equal(song.notes.length, 49);

  const at = (t, hand) => song.notes.filter((x) => x.time === t && x.hand === hand).map((x) => x.note);
  // Bar 1: the tied C–G half notes become one whole-note chord.
  assert.deepEqual(at(0, 'left'), ['C3', 'G3']);
  assert.equal(song.notes.find((x) => x.note === 'C3').duration, 2.4);
  assert.deepEqual(at(1.2, 'left'), []);
  // Bar 4 (first ending): dotted quarter, eighth, half.
  assert.deepEqual(
    song.notes.filter((x) => x.hand === 'right' && x.time >= 7.2 && x.time < 9.6).map((x) => [x.note, x.duration, x.beat]),
    [['E4', 0.9, 1], ['D4', 0.3, 2.5], ['D4', 1.2, 3]],
  );
  // Second time through bar 1, then the second ending ends on C.
  assert.deepEqual(at(9.6, 'right'), ['E4']);
  assert.deepEqual(song.notes.at(-1), { note: 'C4', time: 18, duration: 1.2, hand: 'right', velocity: 0.63, measure: 5, beat: 3 });
  // The left hand rests on beat 4 of the last bar.
  assert.ok(!song.notes.some((x) => x.hand === 'left' && x.time > 18));
});

test('the committed songs/ode-to-joy.json is up to date', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'songs-'));
  try {
    await mkdirCopy(ODE, dir);
    await convertAll({ srcDir: path.join(dir, 'src'), outDir: path.join(dir, 'out'), log: quiet });
    for (const file of ['ode-to-joy.json', 'index.json']) {
      assert.equal(
        await readFile(path.join(dir, 'out', file), 'utf8'),
        await readFile(path.join(ROOT, 'songs', file), 'utf8'),
        `songs/${file} is stale — run: node scripts/convert.mjs`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Timing ─────────────────────────────────────────────────────────────

test('tempo changes mid-measure', () => {
  const { song } = convert(score([tempo(60) + n('C4', 1) + n('D4', 1) + tempo(120) + n('E4', 1) + n('F4', 1), fourQuarters('G4')]));
  assert.deepEqual(song.notes.map((x) => x.time), [0, 1, 2, 2.5, 3, 3.5, 4, 4.5]);
  assert.deepEqual(song.tempos, [{ time: 0, bpm: 60 }, { time: 2, bpm: 120 }]);
  assert.equal(song.duration, 5);
});

test('metronome mark with a dotted beat unit sets the tempo', () => {
  const metronome =
    '<direction><direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>40</per-minute></metronome></direction-type></direction>';
  const dottedQuarter = (p) => n(p, 3, { type: 'quarter', dots: 1 });
  const { song } = convert(score([metronome + dottedQuarter('C4') + dottedQuarter('D4')], { divisions: 2, time: [6, 8] }));
  assert.equal(song.tempo, 60); // dotted quarter = 40 → quarter = 60
  // Beats in 6/8 are counted in eighths: the second dotted quarter starts on beat 4.
  assert.deepEqual(pick(song, ['note', 'time', 'duration', 'beat']), [
    { note: 'C4', time: 0, duration: 1.5, beat: 1 },
    { note: 'D4', time: 1.5, duration: 1.5, beat: 4 },
  ]);
});

test('no tempo marking falls back to ♩ = 120 with a warning', () => {
  const { song, warnings } = convert(score([fourQuarters('C4')]));
  assert.equal(song.tempo, 120);
  assert.equal(song.notes[1].time, 0.5);
  assert.ok(warnings.some((w) => w.includes('no tempo')));
});

test('durations from note type, dots and tuplets when <duration> is missing', () => {
  const triplet = (p) =>
    n(p, null, { type: 'eighth' }).replace('<staff>', '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><staff>');
  const { song } = convert(
    score([tempo(60) + n('C4', null, { type: 'quarter', dots: 2 }) + n('D4', null, { type: '16th' }) + triplet('E4') + triplet('F4') + triplet('G4') + n('A4', null, { type: 'half' })]),
  );
  assert.deepEqual(song.notes.map((x) => x.duration), [1.75, 0.25, 0.333, 0.333, 0.333, 2]);
  assert.deepEqual(song.notes.map((x) => x.time), [0, 1.75, 2, 2.333, 2.667, 3]);
});

test('divisions can change between measures', () => {
  const { song } = convert(
    score([tempo(60) + fourQuarters('C4'), '<attributes><divisions>4</divisions></attributes>' + n('D4', 2) + n('E4', 14)]),
  );
  assert.deepEqual(pick(song).slice(4), [
    { note: 'D4', time: 4, duration: 0.5 },
    { note: 'E4', time: 4.5, duration: 3.5 },
  ]);
});

test('pickup measure: first note is on the right beat and timing starts at 0', () => {
  const { song } = convert(score([{ number: '0', implicit: true, xml: tempo(60) + n('G3', 1) }, fourQuarters('C4')]));
  assert.deepEqual(song.notes[0], { note: 'G3', time: 0, duration: 1, hand: 'right', velocity: 0.63, measure: 0, beat: 4 });
  assert.equal(song.notes[1].time, 1);
  assert.equal(song.notes[1].beat, 1);
  assert.equal(song.duration, 5);
});

// ── Notes ──────────────────────────────────────────────────────────────

test('chords, rests, two voices and both hands', () => {
  const m =
    tempo(60) +
    n('C4', 2) + n('E4', 2, { chord: true }) + rest(2) +
    backup(4) + n('G4', 1, { voice: 2 }) + n('A4', 1, { voice: 2 }) + n('B4', 2, { voice: 2 }) +
    backup(4) + n('C3', 4, { staff: 2, voice: 5 }) + n('E3', 4, { staff: 2, voice: 5, chord: true });
  const { song } = convert(score([m]));
  assert.deepEqual(pick(song, ['note', 'time', 'duration', 'hand']), [
    { note: 'C3', time: 0, duration: 4, hand: 'left' },
    { note: 'E3', time: 0, duration: 4, hand: 'left' },
    { note: 'C4', time: 0, duration: 2, hand: 'right' },
    { note: 'E4', time: 0, duration: 2, hand: 'right' },
    { note: 'G4', time: 0, duration: 1, hand: 'right' },
    { note: 'A4', time: 1, duration: 1, hand: 'right' },
    { note: 'B4', time: 2, duration: 2, hand: 'right' },
  ]);
});

test('ties across bar lines, chains of ties, and a new note of the same pitch', () => {
  const { song } = convert(
    score([
      tempo(60) + n('C4', 2) + n('D4', 2, { tie: ['start'] }),
      n('D4', 4, { tie: ['stop', 'start'] }),
      n('D4', 1, { tie: ['stop'] }) + n('D4', 1) + n('E4', 2),
    ]),
  );
  assert.deepEqual(pick(song), [
    { note: 'C4', time: 0, duration: 2 },
    { note: 'D4', time: 2, duration: 7 },
    { note: 'D4', time: 9, duration: 1 },
    { note: 'E4', time: 10, duration: 2 },
  ]);
});

test('accidentals and transposition give sharp-spelled note names', () => {
  const { song } = convert(score([n('B3', 1) + n('Bb3', 1) + n('C#4', 1) + n('Db4', 1)]));
  assert.deepEqual(song.notes.map((x) => x.note), ['B3', 'A#3', 'C#4', 'C#4']);
  const transposed = convert(
    score(['<attributes><transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>' + fourQuarters('D4')]),
  );
  assert.equal(transposed.song.notes[0].note, 'C4');
});

test('grace notes are skipped without shifting the timing', () => {
  const grace = '<note><grace/><pitch><step>B</step><octave>3</octave></pitch><voice>1</voice><type>eighth</type><staff>1</staff></note>';
  const { song, warnings } = convert(score([tempo(60) + grace + fourQuarters('C4')]));
  assert.deepEqual(song.notes.map((x) => x.time), [0, 1, 2, 3]);
  assert.ok(warnings.some((w) => w.includes('grace')));
});

test('dynamics set velocity per staff; accents only hit their own note', () => {
  const dyn = (mark, staff) =>
    `<direction><direction-type><dynamics><${mark}/></dynamics></direction-type><staff>${staff}</staff></direction>`;
  const m1 = dyn('p', 1) + n('C4', 1) + dyn('sfz', 1) + n('D4', 1) + n('E4', 1) + dyn('ff', 1) + n('F4', 1) + backup(4) + n('C3', 4, { staff: 2 });
  const m2 = n('G4', 4, { attrs: ' dynamics="50"' });
  const { song } = convert(score([m1, m2]));
  const velocity = Object.fromEntries(song.notes.map((x) => [x.note, x.velocity]));
  assert.deepEqual(velocity, { C3: 0.63, C4: 0.39, D4: 0.88, E4: 0.39, F4: 0.88, G4: 0.35 });
});

// ── Repeats ────────────────────────────────────────────────────────────

const bars = (count) => Array.from({ length: count }, (_, i) => fourQuarters(['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4'][i % 7]));

test('simple repeat from the start', () => {
  const m = bars(3);
  m[1] += repeatEnd();
  assert.deepEqual(measureOrder(convert(score(m)).song), [1, 2, 1, 2, 3]);
});

test('repeat played three times with endings "1, 2" and "3"', () => {
  const m = bars(5);
  m[1] = repeatStart + m[1];
  m[2] = ending('1, 2', 'start') + m[2] + ending('1, 2', 'stop') + repeatEnd(3);
  m[3] = ending('3', 'start') + m[3] + ending('3', 'discontinue');
  assert.deepEqual(measureOrder(convert(score(m)).song), [1, 2, 3, 2, 3, 2, 4, 5]);
});

test('two repeated sections in a row, the second without a start sign', () => {
  const m = bars(4);
  m[1] += repeatEnd();
  m[3] += repeatEnd();
  assert.deepEqual(measureOrder(convert(score(m)).song), [1, 2, 1, 2, 3, 4, 3, 4]);
});

test('multi-measure first ending', () => {
  const m = bars(5);
  m[1] = ending('1', 'start') + m[1];
  m[2] = m[2] + ending('1', 'stop') + repeatEnd();
  m[3] = ending('2', 'start') + m[3] + ending('2', 'discontinue');
  assert.deepEqual(measureOrder(convert(score(m)).song), [1, 2, 3, 1, 4, 5]);
});

test('D.C. al Fine: repeats are not taken again and the last ending is played', () => {
  const m = bars(5);
  m[1] = ending('1', 'start') + m[1] + ending('1', 'stop') + repeatEnd();
  m[2] = ending('2', 'start') + m[2] + sound('fine="yes"') + ending('2', 'discontinue');
  m[4] += sound('dacapo="yes"');
  assert.deepEqual(measureOrder(convert(score(m)).song), [1, 2, 1, 3, 4, 5, 1, 3]);
});

test('D.S. al Coda', () => {
  const m = bars(6);
  m[1] = sound('segno="segno"') + m[1];
  m[2] += sound('tocoda="coda"');
  m[4] += sound('dalsegno="segno"');
  m[5] = sound('coda="coda"') + m[5];
  assert.deepEqual(measureOrder(convert(score(m)).song), [1, 2, 3, 4, 5, 2, 3, 6]);
});

test('a tie into both endings is kept in each', () => {
  const m = [
    tempo(60) + n('C4', 2) + n('G4', 2, { tie: ['start'] }),
    ending('1', 'start') + n('G4', 2, { tie: ['stop'] }) + n('E4', 2) + ending('1', 'stop') + repeatEnd(),
    ending('2', 'start') + n('G4', 2, { tie: ['stop'] }) + n('C4', 2) + ending('2', 'discontinue'),
  ];
  const { song } = convert(score(m));
  assert.deepEqual(pick(song).filter((x) => x.note === 'G4'), [
    { note: 'G4', time: 2, duration: 4 },
    { note: 'G4', time: 10, duration: 4 },
  ]);
});

// ── Files ──────────────────────────────────────────────────────────────

/** Builds a .mxl (zip) the way MuseScore does: container.xml + the score. */
function makeMxl(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const packed = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(header, nameBuf, packed);
    central.push(entry, nameBuf);
    offset += header.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const quiet = { log() {}, error() {} };

async function mkdirCopy(file, dir) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await copyFile(file, path.join(dir, 'src', path.basename(file)));
}

test('reads compressed .mxl files and sidecar metadata; writes index.json sorted by level', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'songs-'));
  try {
    await mkdirCopy(ODE, dir);
    const container =
      '<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="score.xml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>';
    const xml = score([tempo(90) + fourQuarters('C4')], { header: '<work><work-title>Scale</work-title></work>' });
    await writeFile(path.join(dir, 'src', 'scale.mxl'), makeMxl({ 'META-INF/container.xml': container, 'score.xml': xml }));
    await writeFile(path.join(dir, 'src', 'ode-to-joy.meta.json'), JSON.stringify({ level: 3 }));
    await writeFile(path.join(dir, 'src', 'scale.meta.json'), JSON.stringify({ level: 2, composer: 'تمرین' }));

    const result = await convertAll({ srcDir: path.join(dir, 'src'), outDir: path.join(dir, 'out'), log: quiet });
    assert.deepEqual(result, { converted: 2, failed: 0 });
    const index = JSON.parse(await readFile(path.join(dir, 'out', 'index.json'), 'utf8'));
    assert.deepEqual(index, [
      { id: 'scale', file: 'scale.json', title: 'Scale', composer: 'تمرین', level: 2, duration: 2.667 },
      { id: 'ode-to-joy', file: 'ode-to-joy.json', title: 'سرود شادی', composer: 'لودویگ فان بتهوون', level: 3, duration: 19.2 },
    ]);
    const scale = JSON.parse(await readFile(path.join(dir, 'out', 'scale.json'), 'utf8'));
    assert.equal(scale.notes.length, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a broken file is reported and index.json is left alone', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'songs-'));
  try {
    await mkdirCopy(ODE, dir);
    await writeFile(path.join(dir, 'src', 'broken.musicxml'), '<score-partwise><part><measure></part>');
    const errors = [];
    const result = await convertAll({
      srcDir: path.join(dir, 'src'),
      outDir: path.join(dir, 'out'),
      log: { log() {}, error: (m) => errors.push(m) },
    });
    assert.deepEqual(result, { converted: 1, failed: 1 });
    assert.ok(errors[0].startsWith('✗ broken.musicxml'));
    assert.deepEqual(await readdir(path.join(dir, 'out')), ['ode-to-joy.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('XML reader handles entities, CDATA, comments and single quotes', () => {
  const doc = parseXml(`<?xml version='1.0'?><!-- c --><a x='1 &amp; 2'><b>&lt;&#65;&#x42;</b><![CDATA[<raw>]]></a>`);
  const a = doc.children[0];
  assert.equal(a.attrs.x, '1 & 2');
  assert.equal(a.children[0].text, '<AB');
  assert.equal(a.text, '<raw>');
  assert.throws(() => parseXml('<a><b></a>'), /does not match/);
});
