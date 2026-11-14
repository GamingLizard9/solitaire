// The Daily Deal: one deal per calendar day, the same for everyone. A date decides the game, its
// variation and the shuffle, using nothing but this file and shared/daily-table.js, so no server
// is involved. The table is generated ahead of time by tools/build-daily.js, which only lists a
// deal once a solver has won it; see that file before changing anything here.
globalThis.Daily = (() => {
  'use strict';

  const FIRST_DAY = '2026-11-06';
  const DONE_KEY = 'daily.completed.v1';
  const SAVES_KEY = 'daily.saves.v1';
  const MAX_SAVES = 6; // unfinished daily games kept; each can hold a long undo history

  // Each way a deal can be played. The table refers to these by position, so only ever add to the
  // end: reordering would change deals people have already played. A play marked `retired` is
  // no longer picked for new days, but deals already listed with it still work.
  const PLAYS = [
    { game: 'klondike', name: 'Klondike', variant: 'Draw 1', value: 1 },
    { game: 'klondike', name: 'Klondike', variant: 'Draw 2', value: 2 },
    { game: 'klondike', name: 'Klondike', variant: 'Draw 3', value: 3 },
    { game: 'freecell', name: 'FreeCell' },
    { game: 'clearview', name: 'Clearview' },
    { game: 'quartet', name: 'Quartet' },
    { game: 'elements', name: 'Elements' },
    { game: 'spider', name: 'Spider', variant: '1 Suit', value: 1 },
    { game: 'spider', name: 'Spider', variant: '2 Suits', value: 2 },
    // Retired: tools/build-daily.js needs a win that doesn't peek at face-down cards, and no
    // 4-suit deal it has tried could be won that way.
    { game: 'spider', name: 'Spider', variant: '4 Suits', value: 4, retired: true },
  ];

  // ---------- Randomness that comes out the same everywhere ----------

  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }

  function seeded(seed) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(a, random = Math.random) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- Dates ----------

  const dayNumber = date => Date.parse(date + 'T00:00:00Z') / 86400000;
  const dateOf = n => new Date(n * 86400000).toISOString().slice(0, 10);
  const utc = date => new Date(date + 'T00:00:00Z');
  const format = (date, options) => utc(date).toLocaleDateString(undefined, { timeZone: 'UTC', ...options });

  const EASTERN = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

  // Days turn over at midnight on US Eastern clocks for everyone, wherever they are. A clock set
  // before the first day gets that day's deal.
  function today() {
    const part = {};
    for (const { type, value } of EASTERN.formatToParts(new Date())) part[type] = value;
    const eastern = `${part.year}-${part.month}-${part.day}`;
    return eastern < FIRST_DAY ? FIRST_DAY : eastern;
  }

  const isPlayable = date =>
    /^\d{4}-\d{2}-\d{2}$/.test(date) && dateOf(dayNumber(date)) === date && date >= FIRST_DAY && date <= today();

  // Every date from today back to the first day, newest first.
  function dates() {
    const out = [];
    for (let n = dayNumber(today()); n >= dayNumber(FIRST_DAY); n--) out.push(dateOf(n));
    return out;
  }

  // ---------- Which deal goes with which date ----------

  // A random game first, then a random variation of it, so a game's odds don't depend on how many
  // variations it has.
  function pick(date) {
    const current = PLAYS.filter(p => !p.retired);
    const games = [...new Set(current.map(p => p.game))];
    const game = games[hash(date + '|game') % games.length];
    const plays = current.filter(p => p.game === game);
    return PLAYS.indexOf(plays[hash(date + '|variant') % plays.length]);
  }

  // The shuffle for one try at a date's deal. The table records which try was proven winnable.
  const random = (date, play, attempt) => seeded(hash(`${date}|${play}|${attempt}`));

  // Each day in the table is two characters: the play and the winning try, both in base 36.
  // A date past the end of the table still gets a deal, it just hasn't been checked.
  function deal(date) {
    const table = globalThis.DAILY_TABLE || '';
    const at = (dayNumber(date) - dayNumber(FIRST_DAY)) * 2;
    const listed = at + 1 < table.length;
    const play = listed ? parseInt(table[at], 36) : pick(date);
    const attempt = listed ? parseInt(table[at + 1], 36) : 0;
    return { date, ...PLAYS[play], play, attempt, verified: listed, random: () => random(date, play, attempt) };
  }

  const label = d => d.variant ? `${d.name} · ${d.variant}` : d.name;

  // The link to play a deal, from a page at the site's top level or one folder down.
  const href = (d, root = '') => `${root}${d.game}/?daily=${d.date}`;

  // The daily deal a game page was opened for, if any. A link to the wrong game is sent on to the
  // right one, so a deal can't be played under another game's rules.
  function forPage(game) {
    const date = new URLSearchParams(location.search).get('daily');
    if (!date || !isPlayable(date)) return null;
    const d = deal(date);
    if (d.game === game) return d;
    location.replace(href(d, '../'));
    return null;
  }

  // ---------- The player's record ----------

  function read(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch {
      return fallback;
    }
  }

  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }

  const completed = () => read(DONE_KEY, {});
  const isDone = date => date in completed();
  const count = () => Object.values(completed()).filter(result => result.onDay).length;

  // Only a deal's first win is recorded. Every win marks the deal as completed, but only one
  // on the deal's own day adds to the total, so archive deals can't run it up.
  function markDone(date, result) {
    const done = completed();
    if (date in done) return;
    done[date] = { ...result, onDay: date === today() };
    write(DONE_KEY, done);
  }

  // Where a daily game in progress is saved. Opening one puts it at the front of the line, and
  // whichever went longest untouched gives up its save once too many are unfinished.
  function saveKey(d) {
    const key = `${d.game}.daily.${d.date}.v1`;
    const saves = [key, ...read(SAVES_KEY, []).filter(k => k !== key)];
    saves.splice(MAX_SAVES).forEach(old => {
      try { localStorage.removeItem(old); } catch { /* storage unavailable */ }
    });
    write(SAVES_KEY, saves);
    return key;
  }

  return {
    FIRST_DAY, PLAYS,
    shuffle, today, dates, dateOf, dayNumber, format, isPlayable, pick, random, deal, label, href, forPage,
    completed, isDone, count, markDone, saveKey,
  };
})();
