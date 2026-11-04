// Sheet-music view for sight reading: the teacher's own score (songs/<name>.musicxml)
// drawn with OpenSheetMusicDisplay, with a cursor that follows the same clock as
// the sound.
//
// const sheet = createSheetView(container, song, { onSeek: (measureIndex) => … });
// await sheet.ready;
// sheet.render(songTime, { loop });   // every frame, like the falling-notes view
//
// Song time → score position: the song JSON lists every measure in playing order
// with its start time and its place in the written score (`index`), so a measure
// heard on the second pass of a repeat maps back to the same printed measure.
// Inside a measure the position is counted in beats (following tempo changes) and
// placed between OSMD's note positions, so the cursor reaches each note exactly
// when it sounds.

const OSMD_URL = new URL('./vendor/opensheetmusicdisplay.min.js', import.meta.url).href;
const EPS = 1e-6;

let osmdPromise = null;
function loadOsmd() {
  if (globalThis.opensheetmusicdisplay) return Promise.resolve(globalThis.opensheetmusicdisplay);
  osmdPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = OSMD_URL;
    script.onload = () => resolve(globalThis.opensheetmusicdisplay);
    script.onerror = () => {
      osmdPromise = null;
      reject(new Error('OpenSheetMusicDisplay could not be loaded'));
    };
    document.head.append(script);
  });
  return osmdPromise;
}

const el = (tag, className) => Object.assign(document.createElement(tag), { className });

/** Last index i with values[i] <= target (or -1). */
function lastAtOrBefore(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= target + EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function createSheetView(container, song, { onSeek = () => {}, onLayout = () => {} } = {}) {
  container.classList.add('sheet');
  container.setAttribute('dir', 'ltr'); // music reads left to right
  container.setAttribute('aria-label', 'نت آهنگ؛ روی هر میزان بزنید تا پخش از آنجا ادامه پیدا کند');

  const status = el('p', 'sheet__status');
  status.setAttribute('dir', 'rtl');
  status.textContent = 'در حال آماده‌سازی نت…';
  const page = el('div', 'sheet__page');
  const host = el('div', 'sheet__score');
  const loopLayer = el('div', 'sheet__loop');
  const band = el('div', 'sheet__measure');
  const cursor = el('div', 'sheet__cursor');
  page.append(loopLayer, band, host, cursor);
  container.append(status, page);

  // ── Timing helpers ───────────────────────────────────────────────
  const measureTimes = song.measures.map((m) => m.time);
  const tempos = song.tempos?.length ? song.tempos : [{ time: 0, bpm: song.tempo || 120 }];

  /** Quarter notes between two song times, following tempo changes. */
  function quartersBetween(from, to) {
    let quarters = 0;
    tempos.forEach((tempo, i) => {
      // Each tempo holds from its time (the first one from the very start) to the next change.
      const start = i === 0 ? -Infinity : tempo.time;
      const end = tempos[i + 1]?.time ?? Infinity;
      const overlap = Math.min(to, end) - Math.max(from, start);
      if (overlap > 0) quarters += (overlap * tempo.bpm) / 60;
    });
    return quarters;
  }

  // Older song files have no written index; fall back to the printed number.
  let numberToIndex = null;

  /** Song time → { instance, written measure index, whole notes into the measure }. */
  function locate(now) {
    if (!song.measures.length) return null;
    const i = Math.max(0, lastAtOrBefore(measureTimes, now));
    const m = song.measures[i];
    const end = song.measures[i + 1]?.time ?? song.duration;
    const clamped = Math.min(Math.max(now, m.time), end);
    return { instance: i, index: m.index ?? numberToIndex?.get(m.number) ?? i, whole: quartersBetween(m.time, clamped) / 4 };
  }

  // ── Score layout (rebuilt after every render) ─────────────────────
  let osmd = null;
  let layout = []; // per written measure
  let renderedWidth = 0;
  let renderedHeight = 0;

  function buildLayout() {
    const sheet = osmd.GraphicSheet;
    const unit = 10 * osmd.zoom; // OSMD units → CSS pixels
    const pageLeft = page.getBoundingClientRect().left;
    // Where a note was actually drawn: the centre of its notehead (or rest) in the SVG.
    const drawnCenter = (note) => {
      const group = note.getSVGGElement?.();
      const head = group?.querySelector('.vf-notehead') ?? group;
      const rect = head?.getBoundingClientRect();
      return rect?.width ? rect.left + rect.width / 2 - pageLeft : null;
    };
    const systems = sheet.MusicPages.flatMap((p) => p.MusicSystems);
    numberToIndex = new Map(sheet.MeasureList.map((staves, i) => [staves.find(Boolean)?.MeasureNumber, i]));

    layout = sheet.MeasureList.map((staves) => {
      const first = staves.find(Boolean);
      const box = first.PositionAndShape;
      const system = first.ParentMusicSystem;
      const lines = system.StaffLines;
      const left = box.AbsolutePosition.x * unit;
      const right = (box.AbsolutePosition.x + box.Size.width) * unit;
      const contentLeft = left + (first.beginInstructionsWidth ?? 0) * unit;
      const duration = first.parentSourceMeasure.Duration.RealValue;

      const xAt = new Map(); // timestamp (whole notes) → x of the leftmost note there
      const notes = [];
      staves.forEach((measure, staffIndex) => {
        for (const entry of measure?.staffEntries ?? []) {
          const ts = entry.relInMeasureTimestamp.RealValue;
          const drawn = entry.graphicalVoiceEntries.flatMap((v) => v.notes.map(drawnCenter)).filter((x) => x !== null);
          const x = drawn.length ? Math.min(...drawn) : entry.PositionAndShape.AbsolutePosition.x * unit;
          xAt.set(ts, Math.min(xAt.get(ts) ?? Infinity, x));
          for (const voice of entry.graphicalVoiceEntries) {
            for (const note of voice.notes) {
              const source = note.sourceNote;
              if (source.isRest() || source.IsGraceNote) continue;
              const svg = note.getSVGGElement?.();
              if (svg) notes.push({ start: ts, end: ts + source.Length.RealValue, svg, hand: staffIndex === 0 ? 'right' : 'left' });
            }
          }
        }
      });
      // Cursor stops: one per note time (on the notehead), then the bar line.
      const points = [...xAt].sort((a, b) => a[0] - b[0]);
      if (!points.length || points[0][0] > EPS) points.unshift([0, contentLeft + unit]);
      points.push([duration, right - 0.4 * unit]);

      return {
        left,
        right,
        top: (lines[0].PositionAndShape.AbsolutePosition.y - 2.5) * unit,
        bottom: (lines[lines.length - 1].PositionAndShape.AbsolutePosition.y + 4 + 2.5) * unit,
        system: systems.indexOf(system),
        points,
        notes,
      };
    });
  }

  function renderScore() {
    const width = page.clientWidth;
    const height = container.clientHeight;
    if (!osmd || width < 50) return false;
    // About 650 OSMD units across a phone screen gives 2–3 measures per line.
    osmd.zoom = Math.min(1.1, Math.max(0.5, width / 650));
    osmd.render();
    buildLayout();
    // A whole line (both staves, with tempo marks and endings) must fit the height,
    // e.g. a phone held sideways; otherwise zoom out until it does.
    const tallest = Math.max(...layout.map((m) => m.bottom - m.top)) + 28;
    if (height > 60 && tallest > height) {
      osmd.zoom = Math.max(0.35, (osmd.zoom * height) / tallest);
      osmd.render();
      buildLayout();
    }
    renderedWidth = width;
    renderedHeight = height;
    lit.clear();
    shown = { index: -1, system: -1, loopKey: null };
    return true;
  }

  // ── Drawing the position ─────────────────────────────────────────
  const lit = new Map(); // svg element → hand
  let shown = { index: -1, system: -1, loopKey: null };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function xFor(m, whole) {
    const p = m.points;
    for (let i = 1; i < p.length; i++) {
      if (whole <= p[i][0] + EPS) {
        const [t0, x0] = p[i - 1];
        const [t1, x1] = p[i];
        return t1 - t0 < EPS ? x1 : x0 + ((whole - t0) / (t1 - t0)) * (x1 - x0);
      }
    }
    return p[p.length - 1][1];
  }

  function placeBox(node, m) {
    node.style.transform = `translate(${m.left}px, ${m.top}px)`;
    node.style.width = `${m.right - m.left}px`;
    node.style.height = `${m.bottom - m.top}px`;
  }

  function drawLoop(loop) {
    const key = loop ? `${loop.start}-${loop.end}` : null;
    if (key === shown.loopKey) return;
    shown.loopKey = key;
    loopLayer.replaceChildren();
    if (!loop) return;
    const indexes = new Set();
    song.measures.forEach((m) => {
      if (m.time >= loop.start - EPS && m.time < loop.end - EPS) indexes.add(m.index ?? numberToIndex?.get(m.number));
    });
    for (const index of indexes) {
      const m = layout[index];
      if (!m) continue;
      const box = el('div', 'sheet__loop-measure');
      placeBox(box, m);
      loopLayer.append(box);
    }
  }

  function scrollToSystem(m) {
    const top = Math.max(0, m.top - 12);
    const visible = top >= container.scrollTop && m.bottom <= container.scrollTop + container.clientHeight;
    // Keep the line being played near the top, so the next line is visible below it.
    if (!visible || Math.abs(container.scrollTop - top) > container.clientHeight * 0.35) {
      container.scrollTo({ top, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    }
  }

  function render(now, { loop = null } = {}) {
    if (!osmd) return;
    // First time visible, or the width changed (rotation, resize): lay the score out again.
    const resized =
      Math.abs(page.clientWidth - renderedWidth) > 1 || Math.abs(container.clientHeight - renderedHeight) > 24;
    if ((!layout.length || resized) && renderScore()) onLayout();
    if (!layout.length) return;
    drawLoop(loop);

    const at = locate(now);
    const m = at && layout[at.index];
    if (!m) return;

    if (at.index !== shown.index) {
      shown.index = at.index;
      placeBox(band, m);
      if (m.system !== shown.system) {
        shown.system = m.system;
        scrollToSystem(m);
      }
    }
    cursor.style.transform = `translate(${xFor(m, at.whole)}px, ${m.top}px)`;
    cursor.style.height = `${m.bottom - m.top}px`;

    // Colour the noteheads that are sounding in their hand's colour.
    const next = new Map();
    for (const note of m.notes) {
      if (note.start <= at.whole + EPS && at.whole < note.end - EPS) next.set(note.svg, note.hand);
    }
    for (const [svg, hand] of lit) {
      if (next.get(svg) !== hand) svg.classList.remove(`is-${hand}`);
    }
    for (const [svg, hand] of next) {
      if (lit.get(svg) !== hand) svg.classList.add(`is-${hand}`);
    }
    lit.clear();
    for (const [svg, hand] of next) lit.set(svg, hand);
  }

  // Tap a measure to continue from there (the pass closest to where the song is now).
  let currentTime = () => 0;
  page.addEventListener('click', (e) => {
    const rect = page.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const index = layout.findIndex((m) => x >= m.left && x <= m.right && y >= m.top && y <= m.bottom);
    if (index < 0) return;
    const now = currentTime();
    let best = -1;
    song.measures.forEach((m, i) => {
      if ((m.index ?? numberToIndex?.get(m.number)) !== index) return;
      if (best < 0 || Math.abs(m.time - now) < Math.abs(song.measures[best].time - now)) best = i;
    });
    if (best >= 0) onSeek(best);
  });

  // ── Loading ──────────────────────────────────────────────────────
  const ready = (async () => {
    if (!song.score) throw new Error('This song has no score file; convert it again');
    const [OSMD, xml] = await Promise.all([
      loadOsmd(),
      fetch(`songs/${encodeURIComponent(song.score)}`, { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error(`Score not found (${r.status})`);
        return r.text();
      }),
    ]);
    const instance = new OSMD.OpenSheetMusicDisplay(host, {
      autoResize: false, // re-rendered by render() when the width changes
      backend: 'svg',
      drawTitle: false, // the page header already shows title and composer
      drawSubtitle: false,
      drawComposer: false,
      drawLyricist: false,
      drawCredits: false,
      drawPartNames: false,
      drawPartAbbreviations: false,
    });
    await instance.load(xml);
    osmd = instance; // only now can render() lay it out
    status.hidden = true;
    // The view may be hidden (waterfall) right now; it is drawn when first shown.
    if (renderScore()) onLayout();
  })();
  ready.catch((err) => {
    console.error(err);
    status.textContent = 'نت این آهنگ بارگذاری نشد. می‌توانید با نمای آبشاری تمرین کنید.';
  });

  return {
    ready,
    render,
    /** Lets a tap on the score pick the repeat pass nearest to the current time. */
    setClock(fn) {
      currentTime = fn;
    },
  };
}
