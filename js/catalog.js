// index.html — lists songs/index.json and links each song to the player.

import { toPersianDigits } from './notes.js';

const list = document.getElementById('songs');
const status = document.getElementById('status');
const levels = document.getElementById('levels');

const PLAY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>';

function formatDuration(seconds) {
  const s = Math.round(seconds);
  return toPersianDigits(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
}

const levelLabel = (level) => `سطح ${toPersianDigits(level)}`;
const hasLevel = (song) => song.level !== null && song.level !== undefined;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function songItem(song) {
  const item = el('li', 'song');
  item.dataset.level = hasLevel(song) ? String(song.level) : '';

  const title = el('h2', 'song__title', song.title);
  const details = el('p', 'song__details');
  if (song.composer) details.append(el('span', 'song__composer', song.composer));
  details.append(el('span', 'song__duration', formatDuration(song.duration)));
  if (hasLevel(song)) details.append(el('span', 'song__level', levelLabel(song.level)));

  const play = el('a', 'song__play');
  play.href = `player.html?song=${encodeURIComponent(song.id)}`;
  play.innerHTML = PLAY_ICON;
  play.append('تمرین');
  play.setAttribute('aria-label', `تمرین «${song.title}»`);

  item.append(title, details, play);
  return item;
}

function setupLevelFilter(songs) {
  const values = [...new Set(songs.filter(hasLevel).map((s) => String(s.level)))];
  if (values.length < 2) return;
  const chips = [{ value: 'all', label: 'همه' }, ...values.map((v) => ({ value: v, label: levelLabel(v) }))];
  for (const { value, label } of chips) {
    const chip = el('button', 'level-chip', label);
    chip.type = 'button';
    chip.dataset.value = value;
    chip.setAttribute('aria-pressed', String(value === 'all'));
    chip.addEventListener('click', () => {
      for (const other of levels.children) other.setAttribute('aria-pressed', String(other === chip));
      for (const item of list.children) item.hidden = value !== 'all' && item.dataset.level !== value;
    });
    levels.append(chip);
  }
  levels.hidden = false;
}

async function load() {
  try {
    const response = await fetch('songs/index.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const songs = await response.json();
    if (!songs.length) {
      status.textContent = 'هنوز آهنگی اضافه نشده است.';
      return;
    }
    list.append(...songs.map(songItem));
    setupLevelFilter(songs);
    status.textContent = '';
  } catch (err) {
    console.error(err);
    status.textContent = 'فهرست آهنگ‌ها بارگذاری نشد. اتصال اینترنت را بررسی کنید و صفحه را دوباره باز کنید.';
  } finally {
    list.removeAttribute('aria-busy');
  }
}

load();
