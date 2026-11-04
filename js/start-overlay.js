// "Tap to start" overlay. Browsers keep audio locked until the user taps, so every
// page that plays sound shows this first. It also waits for the piano samples.
//
// Markup: <button class="start" disabled><span class="start__title">…</span>
//           <span class="start__note" aria-live="polite">…</span></button>

import * as piano from './piano.js';

const START_TEXT = 'مرورگرها تا اولین لمس شما اجازه‌ی پخش صدا نمی‌دهند.';
const LOADING_TEXT = 'در حال بارگذاری صدای پیانو…';
const ERROR_TEXT = 'صدای پیانو بارگذاری نشد. اتصال اینترنت را بررسی کنید و دوباره ضربه بزنید.';

/** Resolves (and calls onReady) once audio is unlocked and the samples are loaded. */
export function setupStartOverlay({ button, note, onReady = () => {} }) {
  let engineFailed = false;

  return new Promise((resolve) => {
    function dismiss() {
      button.classList.add('is-hidden');
      setTimeout(() => (button.hidden = true), 300);
      onReady();
      resolve();
    }

    button.addEventListener('click', async () => {
      if (engineFailed) return location.reload();
      // Must happen synchronously inside the tap, before any await.
      piano.start();
      button.disabled = true;
      note.textContent = LOADING_TEXT;
      try {
        await piano.preload();
        dismiss();
      } catch (err) {
        console.error(err);
        button.disabled = false;
        note.textContent = ERROR_TEXT;
      }
    });

    piano
      .loadEngine()
      .then(() => {
        button.disabled = false;
        note.textContent = START_TEXT;
        button.focus();
        piano.preload().catch(() => {}); // start fetching samples before the tap
      })
      .catch((err) => {
        console.error(err);
        engineFailed = true;
        note.textContent = ERROR_TEXT;
        button.disabled = false;
      });
  });
}
