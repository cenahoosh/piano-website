# Ideas and open items

Things we have talked about but not built yet. Not published to the site.

## Next feature: "wait for me" practice mode

For sight reading: instead of playing on at a fixed speed, the music **waits at each
note until the student plays it**, then moves on.

- Works in both views (sheet music and waterfall). The cursor / falling notes stop on
  the next note and its key is highlighted until the right key is pressed.
- Input: the on-screen keyboard, and a real piano/keyboard over USB or Bluetooth MIDI
  (Web MIDI API — Chrome and Edge on Android and desktop; Safari on iPhone does not
  support it, so on iPhone it would be on-screen keys only).
- Per hand: wait only for the hand the student is practising (the muted hand), while the
  app plays the other hand.
- Chords: wait until every note of the chord is held.
- Feedback: a wrong key flashes red on the keyboard; optionally count correct notes and
  show a short summary at the end of the song or loop.
- Fits the existing pieces: `js/song-player.js` (pause the Transport at the next note's
  time), `js/keyboard.js` (key presses already arrive via `onKeyDown`).

## Open items

- **Close PR #1** (cenahoosh/piano-website#1). It targets the old scaffold branch and
  holds the same commits as `main`, which is what is live.
- **Test a real MuseScore export.** The converter and the sheet view were tested with
  hand-written MusicXML; the first song the teacher exports from MuseScore (`.mxl`) is
  the real test.
- **Check the site from Iran.** GitHub Pages (`*.github.io`) has at times been blocked or
  slow there; if students cannot open it, the site needs another host.
- **Check sound and picture on real phones**, especially that the falling notes and the
  sheet cursor feel in time with the sound (automated tests could not listen).
