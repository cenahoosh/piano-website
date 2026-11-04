# Piano Tutorial Website

A Persian-language piano tutorial website where a teacher publishes songs for students to learn and play along with.

## Language & layout

- All UI text is in Persian (Farsi).
- The page is right-to-left: `<html lang="fa" dir="rtl">`.
- Font: **Vazirmatn**, self-hosted (do not rely on Google Fonts or other CDNs).
- Note: the piano keyboard itself and the falling-notes / timeline view stay physically left-to-right (low notes on the left), even though the surrounding UI is RTL.

## Tech stack

- Plain HTML, CSS and JavaScript using native ES modules (`<script type="module">`).
- No framework, no bundler, no build step. Every file in the repo is served as-is.
- Hosted as a static site on **GitHub Pages**. Use relative paths so the site works from a project sub-path.
- Node.js is used only for offline tooling (the song converter), never at runtime.

## Sound

- Playback uses the **Tone.js** `Sampler` with the **Salamander Grand Piano** samples.
- Samples and the Tone.js library are **self-hosted** in `/assets/piano/` (and alongside it as needed). Do **not** load audio or Tone.js from a CDN: the site must work for students in Iran, where many CDNs are blocked or unreliable.
- Audio can only start after a user gesture (tap/click) — call `Tone.start()` from a button handler.

## Songs pipeline

1. The teacher writes each song in **MuseScore** and exports it as **MusicXML** (`.musicxml` or compressed `.mxl`) into `/songs-src/`.
2. `node scripts/convert.mjs` converts every file into `/songs/<name>.json` and writes `/songs/index.json` (`[{ id, file, title, composer, level, duration }]`). Commit the generated JSON — the site has no build step. Tests: `node --test scripts/convert.test.mjs` (they also fail if the committed JSON is stale).
3. Each note in the JSON has the shape:

   ```json
   { "note": "C4", "time": 0.0, "duration": 0.5, "hand": "right", "velocity": 0.8, "measure": 1, "beat": 1 }
   ```

   - `note`: scientific pitch name, spelled with sharps (e.g. `C4`, `F#3`).
   - `time` / `duration`: in seconds at the written tempo. Repeats are already expanded into playing order; ties are merged.
   - `hand`: `"right"` or `"left"`.
   - `velocity`: 0–1, from the score's dynamics (mf ≈ 0.63 when none are marked).
   - `measure`: the measure number printed in the score; `beat`: 1-based, in the time signature's beat unit (2.5 = halfway through beat 2).
4. Hand assignment comes from the MusicXML staff: **staff 1 = right hand**, **staff 2 = left hand**.
5. A song file also has `title`, `composer`, `level`, `duration`, `tempo`, `timeSignature`, `tempos` and `measures` (start time of each measure in playing order). Title and composer come from MuseScore's score properties; `level` comes from an optional sidecar `songs-src/<name>.meta.json` such as `{ "level": 2 }` (which may also override `title` / `composer`).

## Visual conventions

- Right hand notes: **blue**.
- Left hand notes: **orange**.
- Keep these colors consistent everywhere (keyboard highlights, falling notes, legends). Define them once as CSS custom properties.

## Mobile-first

- Design for phones first; desktop is the enhancement.
- Must work in both **portrait and landscape** on phones. In portrait the keyboard should show a scrollable/zoomable range; in landscape it can show more octaves.
- Use touch-friendly hit targets, avoid hover-only interactions, and test on narrow widths.

## Directory layout

```
/songs-src/     MusicXML exports from MuseScore (source of truth for songs)
/songs/         Generated JSON songs (output of scripts/convert.mjs)
/scripts/       Offline Node tooling (song converter + tests)
/assets/piano/  Self-hosted Salamander Grand Piano samples
/js/            ES module source files
/css/           Stylesheets
```
