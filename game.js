// Guess the Song — game logic.
// Pictures live in images/<song id>-<level>.png. Songs whose picture is missing are skipped.
// Some songs only have some levels (the newer artists only have an Easy picture).

const LEVELS = ['easy', 'medium', 'hard'];
const MODES = [
  { id: 'easy', name: 'Easy', desc: 'The picture shows the song title.' },
  { id: 'medium', name: 'Medium', desc: 'The picture shows what the song is about.' },
  { id: 'hard', name: 'Hard', desc: 'A small detail from the song or its video.' },
  { id: 'mixed', name: 'Mixed', desc: 'A random level for every song.' },
];
const POINTS = { easy: 100, medium: 200, hard: 300 };
const INFO_HINT_COST = 50;
const ROUND_SIZE = 10;
const MAX_TRIES = 3;

const $ = (id) => document.getElementById(id);
const screens = { start: $('screen-start'), play: $('screen-play'), end: $('screen-end') };

const state = {
  songs: [],
  artists: [],
  artist: 'all', // artist id, or 'all'
  available: new Map(), // song id -> Set of levels that have a picture
  mode: 'easy',
  round: [],
  index: 0,
  score: 0,
  streak: 0,
  bestStreak: 0,
  correct: 0,
  answered: false,
};

/* ---------- helpers ---------- */

// The web build (npm run build) bundles the data in window.GAME_DATA and uses small .jpg pictures.
const BUNDLE = window.GAME_DATA || null;
const IMAGE_EXT = BUNDLE?.imageExt || 'png';
const imagePath = (song, level) => `images/${song.id}-${level}.${IMAGE_EXT}`;
const levelName = (level) => level[0].toUpperCase() + level.slice(1);
const songLevels = (song) => LEVELS.filter((level) => song.levels[level]);
const isHebrew = (song) => song.lang === 'he';
const artistOf = (song) => state.artists.find((a) => a.id === song.artist);
const artistName = (song) => artistOf(song)?.name || '';

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

function displayTitle(song) {
  if (!song.with) return song.title;
  return isHebrew(song) ? `${song.title} (עם ${song.with})` : `${song.title} (with ${song.with})`;
}

async function imageExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

// Tate McRae keeps the old key, so best scores from before other artists were added still count.
const bestKey = (mode) => (state.artist === 'tate-mcrae' ? `tate-best-${mode}` : `best-${state.artist}-${mode}`);

function readBest(mode) {
  try { return Number(localStorage.getItem(bestKey(mode))) || 0; } catch { return 0; }
}

function writeBest(mode, score) {
  try { localStorage.setItem(bestKey(mode), String(score)); } catch { /* storage blocked: ignore */ }
}

function readArtist() {
  try { return localStorage.getItem('guess-artist') || 'all'; } catch { return 'all'; }
}

function writeArtist(id) {
  try { localStorage.setItem('guess-artist', id); } catch { /* storage blocked: ignore */ }
}

// Setting: show the artist's name on every question (off by default).
function readShowArtist() {
  try { return localStorage.getItem('show-artist') === '1'; } catch { return false; }
}

function writeShowArtist(on) {
  try { localStorage.setItem('show-artist', on ? '1' : '0'); } catch { /* storage blocked: ignore */ }
}

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  $('hud').hidden = name !== 'play';
  window.scrollTo({ top: 0 });
}

function playableSongs(mode, artist = state.artist) {
  return state.songs.filter((song) => {
    if (artist !== 'all' && song.artist !== artist) return false;
    const levels = state.available.get(song.id);
    if (!levels || levels.size === 0) return false;
    return mode === 'mixed' || levels.has(mode);
  });
}

/* ---------- answer checking ---------- */

// "It's OK, I'm OK!" -> "itsokimok". Case, spaces, punctuation and accents don't matter.
// Hebrew: niqqud doesn't matter, and final letters count as the normal letter (ם = מ).
const HEBREW_FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f\u0591-\u05c7]/g, '')
    .replace(/[ךםןףץ]/g, (c) => HEBREW_FINALS[c])
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\u05d0-\u05ea]/g, '');
}

const hasHebrew = (text) => /[\u05d0-\u05ea]/.test(text);
const hasLatin = (text) => /[a-z]/i.test(text);

// Hebrew songs must be typed in Hebrew, English songs in English.
function wrongLanguage(guess, song) {
  return isHebrew(song) ? !hasHebrew(guess) && hasLatin(guess) : hasHebrew(guess);
}

// Number of single-letter edits (add, remove, change) to turn a into b.
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// How many typos to forgive: none for very short titles, more for long ones.
const allowedTypos = (length) => (length <= 3 ? 0 : length <= 6 ? 1 : length <= 12 ? 2 : 3);

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Returns 'right', 'close' (a few letters off), 'wrong', or 'language' (typed in the wrong language).
function checkGuess(guess, song) {
  if (wrongLanguage(guess, song)) return 'language';
  let g = normalize(guess);
  // Ignore the artist's name if the player adds it ("Greedy by Tate McRae").
  const artist = artistOf(song);
  for (const name of [artist?.name, ...(artist?.aliases || [])].filter(Boolean).map(normalize)) {
    if (name) g = g.replace(new RegExp(`(by|של|מאת)?${escapeRegExp(name)}`, 'g'), '');
  }
  if (song.with) g = g.replace(new RegExp(`(with|feat|ft|featuring|and|עמ|ו)?${escapeRegExp(normalize(song.with))}`, 'g'), '');
  if (!g) return 'wrong';
  const digits = (s) => s.replace(/\D/g, '');
  let best = 'wrong';
  for (const name of [song.title, ...(song.aliases || [])]) {
    const target = normalize(name);
    const d = editDistance(g, target);
    const numbersMatch = digits(g) === digits(target); // "10:36" is not "10:35"
    if (numbersMatch && d <= allowedTypos(target.length)) return 'right';
    if (d <= allowedTypos(target.length) + 2 && target.length > 3 && g.length * 2 >= target.length) best = 'close';
  }
  return best;
}

/* ---------- start screen ---------- */

function renderArtists() {
  const box = $('artists');
  box.innerHTML = '';
  const options = [{ id: 'all', name: 'All artists' }, ...state.artists];
  for (const artist of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'artist-chip';
    btn.textContent = artist.name;
    btn.setAttribute('aria-pressed', String(state.artist === artist.id));
    btn.addEventListener('click', () => {
      state.artist = artist.id;
      writeArtist(artist.id);
      renderStart();
    });
    box.appendChild(btn);
  }
}

function renderStart() {
  renderArtists();
  $('show-artist').checked = readShowArtist();
  const box = $('levels');
  box.innerHTML = '';
  for (const mode of MODES) {
    const count = playableSongs(mode.id).length;
    const best = readBest(mode.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'level-card';
    btn.dataset.level = mode.id;
    btn.disabled = count === 0;
    btn.innerHTML = `
      <span class="level-name">${mode.name}</span>
      <span class="level-desc">${mode.desc}</span>
      <span class="level-meta">${count === 0 && (mode.id === 'medium' || mode.id === 'hard')
        ? 'Only Tate McRae songs have this level'
        : `<strong>${count}</strong> songs${best ? ` · best <strong>${best}</strong>` : ''}`}</span>`;
    btn.addEventListener('click', () => startRound(mode.id));
    box.appendChild(btn);
  }

  const songs = state.songs.filter((s) => state.artist === 'all' || s.artist === state.artist);
  const totalPictures = songs.reduce((n, s) => n + (state.available.get(s.id)?.size || 0), 0);
  const allPictures = songs.reduce((n, s) => n + songLevels(s).length, 0);
  $('start-status').textContent = totalPictures === 0
    ? 'No pictures yet for this artist. Add them to the images folder, run "npm run check", then reload.'
    : totalPictures < allPictures
      ? `${totalPictures} of ${allPictures} pictures ready. Songs without a picture are skipped.`
      : `${songs.length} songs, ${allPictures} pictures.`;
  show('start');
}

/* ---------- round ---------- */

function startRound(mode) {
  const pool = shuffle(playableSongs(mode)).slice(0, ROUND_SIZE);
  if (pool.length === 0) return;

  state.mode = mode;
  state.round = pool.map((song) => {
    const levels = [...state.available.get(song.id)];
    const level = mode === 'mixed' ? pick(levels) : mode;
    return {
      song,
      level,          // level the question started at
      shown: level,   // level currently shown (changes when a hint swaps the picture)
      infoHint: false,
      guesses: [],
      result: null,
    };
  });
  state.index = 0;
  state.score = 0;
  state.streak = 0;
  state.bestStreak = 0;
  state.correct = 0;
  updateHud();
  show('play');
  showQuestion();
}

function easierLevel(q) {
  const levels = state.available.get(q.song.id);
  for (let i = LEVELS.indexOf(q.shown) - 1; i >= 0; i--) {
    if (levels.has(LEVELS[i])) return LEVELS[i];
  }
  return null;
}

function setPicture(q) {
  const frame = $('clue-frame');
  const img = $('clue-img');
  frame.classList.add('loading');
  img.onload = () => frame.classList.remove('loading');
  img.onerror = () => frame.classList.remove('loading');
  img.src = imagePath(q.song, q.shown);
  const badge = $('q-level');
  badge.textContent = levelName(q.shown);
  badge.dataset.level = q.shown;
}

function updateHintButton(q) {
  const btn = $('hint-btn');
  const easier = easierLevel(q);
  if (q.result) {
    btn.disabled = true;
    btn.textContent = 'Hint';
  } else if (easier) {
    btn.disabled = false;
    btn.textContent = `Hint: show ${easier} picture (worth ${POINTS[easier]})`;
  } else if (!q.infoHint) {
    btn.disabled = false;
    btn.textContent = `Hint: year & album (−${INFO_HINT_COST} pts)`;
  } else {
    btn.disabled = true;
    btn.textContent = 'No more hints';
  }
}

function setMessage(text, tone = '') {
  const msg = $('guess-msg');
  msg.textContent = text;
  msg.className = `guess-msg ${tone}`;
}

function triesLeftText(q) {
  const left = MAX_TRIES - q.guesses.length;
  return `${left} ${left === 1 ? 'try' : 'tries'} left`;
}

function showQuestion() {
  const q = state.round[state.index];
  state.answered = false;

  $('q-number').textContent = state.index + 1;
  $('q-total').textContent = state.round.length;
  $('progress-fill').style.width = `${(state.index / state.round.length) * 100}%`;
  $('info-hint').hidden = true;
  $('feedback').hidden = true;

  setPicture(q);
  updateHintButton(q);

  // Hebrew songs are answered in Hebrew, English songs in English.
  const hebrew = isHebrew(q.song);
  const lang = hebrew ? 'Answer in <strong>Hebrew</strong> · כתבו בעברית' : 'Answer in <strong>English</strong>';
  $('answer-lang').innerHTML = readShowArtist() && artistName(q.song)
    ? `Artist: <strong>${artistName(q.song)}</strong> · ${lang}`
    : lang;
  const input = $('guess-input');
  input.placeholder = hebrew ? 'כתבו את שם השיר בעברית…' : 'Type the song name in English…';
  input.dir = hebrew ? 'rtl' : 'ltr';
  input.lang = hebrew ? 'he' : 'en';
  input.value = '';
  input.disabled = false;
  input.className = 'guess-input';
  $('guess-btn').disabled = false;
  $('giveup-btn').disabled = false;
  setMessage(triesLeftText(q));
  // On phones, opening the keyboard right away hides the picture, so only focus on bigger screens.
  if (window.matchMedia('(min-width: 700px)').matches) input.focus({ preventScroll: true });

  // Warm the cache for the next picture.
  const next = state.round[state.index + 1];
  if (next) new Image().src = imagePath(next.song, next.shown);
}

function useHint() {
  const q = state.round[state.index];
  if (state.answered) return;
  const easier = easierLevel(q);
  if (easier) {
    q.shown = easier;
    setPicture(q);
  } else if (!q.infoHint) {
    q.infoHint = true;
    const hint = $('info-hint');
    hint.textContent = `${artistName(q.song)} · released ${q.song.year} · ${q.song.album}`;
    hint.hidden = false;
  }
  updateHintButton(q);
}

function questionPoints(q) {
  return Math.max(0, POINTS[q.shown] - (q.infoHint ? INFO_HINT_COST : 0));
}

function submitGuess(event) {
  event.preventDefault();
  if (state.answered) return;
  const q = state.round[state.index];
  const input = $('guess-input');
  const guess = input.value.trim();
  if (!guess) {
    input.focus();
    return;
  }

  const verdict = checkGuess(guess, q.song);
  if (verdict === 'language') {
    // Doesn't use up a try.
    setMessage(isHebrew(q.song)
      ? 'This is a Hebrew song: write the name in Hebrew · זה שיר בעברית, כתבו בעברית'
      : 'This is an English song: write the name in English', 'close');
    input.select();
    return;
  }
  q.guesses.push(guess);
  if (verdict === 'right') {
    finish(true);
    return;
  }
  if (q.guesses.length >= MAX_TRIES) {
    finish(false);
    return;
  }

  setMessage(
    verdict === 'close'
      ? `So close! Check the spelling · ${triesLeftText(q)}`
      : `Not that one · ${triesLeftText(q)}`,
    verdict === 'close' ? 'close' : 'bad',
  );
  input.classList.remove('shake');
  void input.offsetWidth; // restart the shake animation
  input.classList.add('shake');
  input.select();
}

function finish(isRight) {
  if (state.answered) return;
  state.answered = true;
  const q = state.round[state.index];

  const input = $('guess-input');
  input.disabled = true;
  input.classList.remove('shake');
  input.classList.add(isRight ? 'correct' : 'wrong');
  $('guess-btn').disabled = true;
  $('giveup-btn').disabled = true;
  setMessage('');

  const points = isRight ? questionPoints(q) : 0;
  q.result = { right: isRight, points };
  if (isRight) {
    state.score += points;
    state.correct++;
    state.streak++;
    state.bestStreak = Math.max(state.bestStreak, state.streak);
  } else {
    state.streak = 0;
  }
  updateHud();
  updateHintButton(q);
  showFeedback(q);
}

function showFeedback(q) {
  const title = $('feedback-title');
  const by = artistName(q.song) ? ` by ${artistName(q.song)}` : '';
  title.textContent = q.result.right
    ? `Yes! “${displayTitle(q.song)}”${by} +${q.result.points}`
    : `It was “${displayTitle(q.song)}”${by}`;
  title.className = `feedback-title ${q.result.right ? 'good' : 'bad'}`;
  $('feedback-idea').textContent = q.song.levels[q.shown].idea;

  const wrongGuesses = q.result.right ? q.guesses.slice(0, -1) : q.guesses;
  const guessLine = $('feedback-guesses');
  guessLine.textContent = wrongGuesses.length ? `Your guesses: ${wrongGuesses.join(', ')}` : '';
  guessLine.hidden = wrongGuesses.length === 0;

  // After a miss, show all of this song's pictures so the player can see the other clues.
  // After a right guess, keep it clean and show none.
  const clues = $('feedback-clues');
  clues.innerHTML = '';
  const levels = q.result.right ? new Set() : state.available.get(q.song.id);
  for (const level of LEVELS) {
    if (!levels.has(level)) continue;
    const item = document.createElement('div');
    item.className = `mini-clue${level === q.shown ? ' current' : ''}`;
    const img = document.createElement('img');
    img.src = imagePath(q.song, level);
    img.alt = `${levelName(level)} picture for ${q.song.title}`;
    img.title = q.song.levels[level].idea;
    img.loading = 'lazy';
    const label = document.createElement('span');
    label.textContent = levelName(level);
    item.append(img, label);
    clues.appendChild(item);
  }
  if (clues.children.length < 2) clues.innerHTML = '';

  const last = state.index === state.round.length - 1;
  $('next-btn').textContent = last ? 'See results' : 'Next song';
  $('feedback').hidden = false;
  $('next-btn').focus({ preventScroll: true });
  $('feedback').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function next() {
  if (!state.answered) return;
  if (state.index < state.round.length - 1) {
    state.index++;
    showQuestion();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    endRound();
  }
}

function updateHud() {
  $('hud-score').textContent = state.score;
  $('hud-streak').textContent = state.streak;
}

/* ---------- results ---------- */

function endRound() {
  $('progress-fill').style.width = '100%';
  const max = state.round.reduce((n, q) => n + POINTS[q.level], 0);
  const prevBest = readBest(state.mode);
  const isBest = state.score > prevBest;
  if (isBest) writeBest(state.mode, state.score);

  const artist = state.artists.find((a) => a.id === state.artist);
  $('end-level').textContent = `${artist ? `${artist.name} · ` : ''}${levelName(state.mode)} level`;
  $('end-score').textContent = state.score;
  $('end-max').textContent = max;
  const total = state.round.length;
  const ratio = state.correct / total;
  const cheer = ratio === 1 ? 'Perfect — true fan!' : ratio >= 0.7 ? 'Great ear!' : ratio >= 0.4 ? 'Not bad!' : `Time for a ${artist ? artist.name : 'new'} playlist.`;
  $('end-line').textContent = `${state.correct} of ${total} right · best streak ${state.bestStreak}. ${cheer}`;
  $('end-best').textContent = isBest ? 'New best score!' : `Best: ${prevBest}`;

  const list = $('recap');
  list.innerHTML = '';
  for (const q of state.round) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = imagePath(q.song, q.level);
    img.alt = '';
    const text = document.createElement('div');
    const t = document.createElement('div');
    t.className = 'r-title';
    t.textContent = displayTitle(q.song);
    const sub = document.createElement('div');
    sub.className = 'r-sub';
    const notes = [levelName(q.level)];
    if (q.shown !== q.level || q.infoHint) notes.push('used a hint');
    if (!q.result?.right && q.guesses.length < MAX_TRIES) notes.push('gave up');
    sub.textContent = notes.join(' · ');
    text.append(t, sub);
    const mark = document.createElement('span');
    mark.className = `r-mark ${q.result?.right ? 'good' : 'bad'}`;
    mark.textContent = q.result?.right ? `+${q.result.points}` : '✕';
    li.append(img, text, mark);
    list.appendChild(li);
  }
  show('end');
}

/* ---------- events ---------- */

$('guess-form').addEventListener('submit', submitGuess);
$('hint-btn').addEventListener('click', useHint);
$('show-artist').addEventListener('change', (e) => writeShowArtist(e.target.checked));
$('giveup-btn').addEventListener('click', () => finish(false));
$('next-btn').addEventListener('click', next);
$('again-btn').addEventListener('click', () => startRound(state.mode));
$('change-btn').addEventListener('click', renderStart);
$('home-btn').addEventListener('click', renderStart);

// Enter moves on to the next song once the answer is shown.
document.addEventListener('keydown', (e) => {
  if (screens.play.hidden || !state.answered || e.key !== 'Enter') return;
  if (document.activeElement === $('next-btn')) return; // the button handles its own Enter
  e.preventDefault();
  next();
});

/* ---------- boot ---------- */

async function boot() {
  let ready = null;
  if (BUNDLE) {
    state.songs = BUNDLE.songs;
    state.artists = BUNDLE.artists || [];
    ready = new Set(BUNDLE.images);
  } else {
    try {
      const res = await fetch('data/songs.json', { cache: 'no-store' });
      const data = await res.json();
      state.songs = data.songs;
      state.artists = data.artists || [];
    } catch {
      $('start-status').textContent = 'Could not load the song list. Start the game with "npm start" and open the link it prints.';
      return;
    }
    $('start-status').textContent = 'Loading pictures…';

    // data/images.json (written by "npm run check") lists the ready pictures.
    // Without it, ask the server about each picture instead.
    try {
      const res = await fetch('data/images.json', { cache: 'no-store' });
      if (res.ok) ready = new Set(await res.json());
    } catch { /* fall back to checking each picture */ }
  }

  const saved = readArtist();
  state.artist = saved === 'all' || state.artists.some((a) => a.id === saved) ? saved : 'all';

  await Promise.all(state.songs.flatMap((song) => songLevels(song).map(async (level) => {
    const path = imagePath(song, level);
    const ok = ready ? ready.has(path) : await imageExists(path);
    if (ok) {
      if (!state.available.has(song.id)) state.available.set(song.id, new Set());
      state.available.get(song.id).add(level);
    }
  })));
  renderStart();
}

boot();
