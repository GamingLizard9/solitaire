(() => {
  'use strict';

  // ---------- Card data ----------

  const SUITS = [
    { sym: '♠', color: 'black', name: 'Spades' },
    { sym: '♥', color: 'red', name: 'Hearts' },
    { sym: '♣', color: 'black', name: 'Clubs' },
    { sym: '♦', color: 'red', name: 'Diamonds' },
  ];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const TEXT_STYLE = '︎'; // keep suit glyphs from rendering as emoji

  // Suits are drawn as SVG on a 100×100 box rather than font glyphs, whose vertical
  // placement varies by system font. Each shape is nudged so its visual weight, not
  // its bounding box, sits at the centre: the heart's mass is up in its lobes, the
  // spade's is down in its base.
  const SUIT_PATHS = [
    '<path d="M50 4C80 28 96 44 96 62C96 76 86 84 74 84C64 84 56 79 52 72C53 82 57 90 64 96H36C43 90 47 82 48 72C44 79 36 84 26 84C14 84 4 76 4 62C4 44 20 28 50 4Z"/>',
    '<path d="M50 92C22 71 8 55 8 36C8 20 18 10 31 10C40 10 47 16 50 24C53 16 60 10 69 10C82 10 92 20 92 36C92 55 78 71 50 92Z"/>',
    '<circle cx="50" cy="27" r="21"/><circle cx="26" cy="58" r="21"/><circle cx="74" cy="58" r="21"/><circle cx="50" cy="46" r="8"/><path d="M45 50C45 74 40 88 31 96H69C60 88 55 74 55 50Z"/>',
    '<path d="M50 4L88 50L50 96L12 50Z"/>',
  ];
  const SUIT_NUDGE = [-4, 4, -1, 0]; // optical vertical offset, in viewBox units
  const suitSVG = s =>
    `<svg class="suit-svg" viewBox="0 0 100 100" aria-hidden="true"><g transform="translate(0 ${SUIT_NUDGE[s]})">${SUIT_PATHS[s]}</g></svg>`;
  const CARDS = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 1; r <= 13; r++) CARDS.push({ id: CARDS.length, suit: s, rank: r, color: SUITS[s].color });
  }

  const GAME_KEY = 'clearview.game.v1';
  const STATS_KEY = 'clearview.stats.v1';
  const SETTINGS_KEY = 'clearview.settings.v1';
  const DRAW_COUNT = 3;
  const DIM_LOCKED = true; // darken cards buried under ones that can be played
  const AUTO_STEP = 140;        // ms between safe auto-plays
  const AUTO_BEAT = 400;        // ms pause after a card turns over, before it's auto-played
  const AUTO_AFTER_FLIP = 500 + AUTO_BEAT; // the flip itself takes 0.5s

  const $ = sel => document.querySelector(sel);
  const board = $('#board');
  const hud = $('#hud');
  const modal = $('#modal');

  let state;         // { stock, waste, free, foundations[4], tableau[7], moves }
  let history = [];  // JSON snapshots of previous states, for undo
  let meta;          // { counted, won, elapsed } — per-game bookkeeping that undo doesn't touch
  let stats;         // { wins, played, best }
  let settings;      // { autoSafe }
  let L = {};        // layout metrics
  let P = {};        // card id -> { x, y, z, down, key }
  const els = [];
  const slots = {};
  let drag = null;
  let busy = false;
  let hintTimer = null;
  let hintIndex = 0;
  let dropEl = null;
  let winTimers = [];
  let autoTimer = null;
  const clock = { acc: 0, since: null };

  // ---------- Storage ----------

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }

  function save() {
    meta.elapsed = elapsed();
    store(GAME_KEY, { state, history: history.slice(-300), meta });
  }

  const saveStats = () => store(STATS_KEY, stats);
  const saveSettings = () => store(SETTINGS_KEY, settings);

  // ---------- Rules helpers ----------

  const card = id => CARDS[id];
  const last = arr => arr[arr.length - 1];
  const nameOf = id => RANKS[card(id).rank - 1] + SUITS[card(id).suit].sym + TEXT_STYLE;
  const freeActive = () => state.stock.length === 0;
  const foundCount = () => state.foundations.reduce((n, f) => n + f.length, 0);
  const same = (a, b) => a.type === b.type && a.idx === b.idx;

  // Can `lower` be placed directly onto `upper` in the tableau?
  const fits = (lower, upper) =>
    card(upper).rank === card(lower).rank + 1 && card(upper).color !== card(lower).color;

  const canFound = id => card(id).rank === state.foundations[card(id).suit].length + 1;

  function isRun(col, from) {
    for (let j = from + 1; j < col.length; j++) if (!fits(col[j], col[j - 1])) return false;
    return true;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function freshState() {
    const deck = shuffle([...Array(52).keys()]);
    const tableau = Array.from({ length: 7 }, () => []);
    let k = 0;
    for (let row = 0; row < 7; row++) {
      for (let c = row; c < 7; c++) tableau[c].push(deck[k++]);
    }
    return { stock: deck.slice(k), waste: [], free: null, foundations: [[], [], [], []], tableau, moves: 0 };
  }

  function locate(id) {
    let i;
    if ((i = state.stock.indexOf(id)) >= 0) return { type: 'stock', pos: i };
    if ((i = state.waste.indexOf(id)) >= 0) return { type: 'waste', pos: i };
    if (state.free === id) return { type: 'free', pos: 0 };
    for (let f = 0; f < 4; f++) {
      if ((i = state.foundations[f].indexOf(id)) >= 0) return { type: 'found', idx: f, pos: i };
    }
    for (let c = 0; c < 7; c++) {
      if ((i = state.tableau[c].indexOf(id)) >= 0) return { type: 'tableau', idx: c, pos: i };
    }
    return null;
  }

  function pileOf(ref, s = state) {
    switch (ref.type) {
      case 'stock': return s.stock;
      case 'waste': return s.waste;
      case 'free': return s.free === null ? [] : [s.free];
      case 'found': return s.foundations[ref.idx];
      case 'tableau': return s.tableau[ref.idx];
    }
    return [];
  }

  // The cards that come along when picking up the card at `loc`, or null if it can't be picked up.
  function grab(loc) {
    if (loc.type === 'stock' || loc.type === 'found') return null;
    const pile = pileOf(loc);
    if (loc.type === 'tableau') return isRun(pile, loc.pos) ? pile.slice(loc.pos) : null;
    return loc.pos === pile.length - 1 ? [pile[loc.pos]] : null;
  }

  function canDrop(ids, from, to) {
    if (same(from, to)) return false;
    const first = ids[0];
    if (to.type === 'tableau') {
      const col = state.tableau[to.idx];
      return !col.length || fits(first, last(col));
    }
    if (to.type === 'found') {
      return ids.length === 1 && card(first).suit === to.idx && canFound(first);
    }
    if (to.type === 'free') return ids.length === 1 && freeActive() && state.free === null;
    return false;
  }

  function take(s, from, count) {
    if (from.type === 'free') {
      const id = s.free;
      s.free = null;
      return [id];
    }
    const pile = pileOf(from, s);
    return pile.splice(pile.length - count, count);
  }

  function put(s, to, ids) {
    if (to.type === 'free') s.free = ids[0];
    else pileOf(to, s).push(...ids);
  }

  // ---------- Actions ----------

  function snapshot() {
    history.push(JSON.stringify(state));
    if (history.length > 400) history.shift();
  }

  function move(from, ids, to) {
    snapshot();
    put(state, to, take(state, from, ids.length));
    state.moves++;
    committed();
  }

  function draw() {
    if (busy || meta.won || !state.stock.length) return;
    snapshot();
    const n = Math.min(DRAW_COUNT, state.stock.length);
    for (let i = 0; i < n; i++) state.waste.push(state.stock.pop());
    state.moves++;
    committed(false, false, AUTO_AFTER_FLIP);
    bump(slots.badge);
    if (!state.stock.length) setTimeout(() => toast('Deck exhausted — its spot is now a free cell'), 400);
  }

  function undo() {
    if (busy || meta.won) return;
    if (!history.length) {
      toast('Nothing to undo');
      return;
    }
    state = JSON.parse(history.pop());
    committed(true);
  }

  // `auto` marks a safe auto-play: it rides on the previous move's undo snapshot and isn't
  // counted, so one Undo takes back a move together with the cards it sent home.
  function committed(isUndo = false, auto = false, autoWait = AUTO_STEP) {
    hintIndex = 0;
    clearHint();
    if (!isUndo && !auto) {
      if (!meta.counted) {
        meta.counted = true;
        stats.played++;
        saveStats();
      }
      if (clock.since === null) clock.since = Date.now();
    }
    render();
    updateHud();
    checkWin();
    save();
    if (!isUndo) autoPlay(autoWait);
  }

  // Click / tap: send the card (and its run) to the best legal spot.
  function clickMove(from, ids) {
    const tries = [];
    if (ids.length === 1) tries.push({ type: 'found', idx: card(ids[0]).suit });
    for (let c = 0; c < 7; c++) if (state.tableau[c].length) tries.push({ type: 'tableau', idx: c });
    if (!(from.type === 'tableau' && from.pos === 0)) {
      const empty = state.tableau.findIndex(col => !col.length);
      if (empty >= 0) tries.push({ type: 'tableau', idx: empty });
    }
    if (from.type === 'waste' || from.type === 'tableau') tries.push({ type: 'free' });
    const target = tries.find(t => canDrop(ids, from, t));
    if (target) move(from, ids, target);
    else shake(ids);
  }

  // ---------- Safe auto-play ----------

  // A card is safe to send home when no winning line could still need it in the tableau.
  // With rank r, the only cards that can sit on it are the two opposite-colour (r-1)s; on
  // those, only its own (r-2) — already home — and its same-colour twin's (r-2); on that,
  // only opposite-colour (r-3)s. So it's safe once both opposite-colour foundations reach
  // r-1, or reach r-2 while the twin suit reaches r-3: then each of those (r-1)s and the
  // (r-2) can go straight home whenever a winning line would have put it on this card.
  // Foundation cards never come back, so any win from before the move has a counterpart
  // after it, and auto-playing such cards never turns a winnable deal into a lost one.
  function isSafeHome(id, s = state) {
    const { rank, suit } = card(id);
    const f = s.foundations;
    if (rank !== f[suit].length + 1) return false;
    const opp = Math.min(f[(suit + 1) % 4].length, f[(suit + 3) % 4].length);
    const twin = f[(suit + 2) % 4].length;
    return opp >= rank - 1 || (opp >= rank - 2 && twin >= rank - 3);
  }

  function autoPlay(wait = AUTO_STEP) {
    if (!settings.autoSafe || busy || meta.won || autoTimer) return;
    if (!nextFoundationMove(state, isSafeHome)) return;
    busy = true;
    autoTimer = setTimeout(() => {
      autoTimer = null;
      busy = false;
      const m = settings.autoSafe && !meta.won && nextFoundationMove(state, isSafeHome);
      if (!m) return;
      put(state, m.to, take(state, m.from, 1));
      committed(false, true); // chains into the next safe card, if any
    }, wait);
  }

  function stopAutoPlay() {
    if (!autoTimer) return;
    clearTimeout(autoTimer);
    autoTimer = null;
    busy = false;
  }

  // ---------- Auto-finish ----------

  function nextFoundationMove(s, allow = () => true) {
    const sources = [];
    if (s.waste.length) sources.push({ from: { type: 'waste' }, id: last(s.waste) });
    if (s.free !== null) sources.push({ from: { type: 'free' }, id: s.free });
    s.tableau.forEach((col, c) => {
      if (col.length) sources.push({ from: { type: 'tableau', idx: c, pos: col.length - 1 }, id: last(col) });
    });
    let best = null;
    for (const src of sources) {
      const c = card(src.id);
      if (c.rank === s.foundations[c.suit].length + 1 && allow(src.id, s) && (!best || c.rank < card(best.ids[0]).rank)) {
        best = { from: src.from, ids: [src.id], to: { type: 'found', idx: c.suit } };
      }
    }
    return best;
  }

  function canAutoFinish() {
    if (meta.won || state.stock.length || foundCount() === 52) return false;
    const s = JSON.parse(JSON.stringify(state));
    let m;
    while ((m = nextFoundationMove(s))) put(s, m.to, take(s, m.from, 1));
    return s.foundations.every(f => f.length === 13);
  }

  function autoFinish() {
    if (busy || !canAutoFinish()) return;
    busy = true;
    $('#btn-auto').classList.add('hidden');
    const step = () => {
      const m = nextFoundationMove(state);
      if (!m) {
        busy = false;
        updateHud();
        return;
      }
      move(m.from, m.ids, m.to);
      if (!meta.won) setTimeout(step, 115); // on a win the celebration takes over
    };
    step();
  }

  // ---------- Hints ----------

  function findHints() {
    const out = [];
    const sources = [];
    if (state.waste.length) sources.push({ from: { type: 'waste' }, ids: [last(state.waste)] });
    if (state.free !== null) sources.push({ from: { type: 'free' }, ids: [state.free] });
    state.tableau.forEach((col, c) => {
      for (let i = 0; i < col.length; i++) {
        if (isRun(col, i)) sources.push({ from: { type: 'tableau', idx: c, pos: i }, ids: col.slice(i) });
      }
    });

    const firstEmpty = state.tableau.findIndex(col => !col.length);

    // Would exposing `id` open up a new play?
    const opensTableauCard = (id, movingFrom) =>
      canFound(id) ||
      sources.some(s => !same(s.from, movingFrom) && fits(s.ids[0], id));
    const opensWasteCard = id =>
      canFound(id) || firstEmpty >= 0 || state.tableau.some(col => col.length && fits(id, last(col)));

    for (const src of sources) {
      const { from, ids } = src;
      const base = ids[0];
      const single = ids.length === 1;
      const col = from.type === 'tableau' ? state.tableau[from.idx] : null;
      const below = col && from.pos > 0 ? col[from.pos - 1] : null;
      const belowToFound = below !== null && canFound(below);
      const alreadyRun = below !== null && fits(base, below);

      if (single && canFound(base)) {
        out.push({ ...src, to: { type: 'found', idx: card(base).suit }, score: 100 });
      }

      for (let c = 0; c < 7; c++) {
        const target = state.tableau[c];
        if (!target.length || (from.type === 'tableau' && from.idx === c)) continue;
        if (!fits(base, last(target))) continue;
        let score;
        if (from.type === 'free') score = 70;
        else if (from.type === 'waste') score = 60;
        else if (from.pos === 0) score = 55;
        else if (alreadyRun) {
          if (!belowToFound) continue; // shuffling a run between equal parents gains nothing
          score = 48;
        } else score = 45 + (belowToFound ? 10 : 0);
        out.push({ ...src, to: { type: 'tableau', idx: c }, score });
      }

      if (firstEmpty >= 0 && !(from.type === 'tableau' && from.pos === 0)) {
        const king = card(base).rank === 13;
        let score = null;
        if (from.type === 'tableau') {
          if (!alreadyRun || belowToFound) score = 22 + (belowToFound ? 10 : 0) + (king ? 10 : 0);
        } else {
          score = king ? 30 : (from.type === 'free' ? 24 : 15);
        }
        if (score !== null) out.push({ ...src, to: { type: 'tableau', idx: firstEmpty }, score });
      }

      if (single && freeActive() && state.free === null) {
        if (from.type === 'waste' && state.waste.length > 1 && opensWasteCard(state.waste[state.waste.length - 2])) {
          out.push({ ...src, to: { type: 'free' }, score: 12 });
        } else if (from.type === 'tableau' && below !== null && !alreadyRun && opensTableauCard(below, from)) {
          out.push({ ...src, to: { type: 'free' }, score: 12 });
        }
      }
    }

    if (state.stock.length) out.push({ draw: true, score: 20 });
    return out.sort((a, b) => b.score - a.score);
  }

  function describe(h) {
    if (h.draw) return 'Draw three from the deck';
    const what = nameOf(h.ids[0]) + (h.ids.length > 1 ? ` and the ${h.ids.length - 1} below it` : '');
    const pile = pileOf(h.to);
    let where;
    if (h.to.type === 'found') where = 'to its foundation';
    else if (h.to.type === 'free') where = 'into the free cell';
    else where = pile.length ? `onto ${nameOf(last(pile))}` : 'into the empty column';
    return `Move ${what} ${where}`;
  }

  function targetEl(to) {
    if (to.type === 'free') return slots.stock;
    const pile = pileOf(to);
    if (pile.length) return els[last(pile)];
    return to.type === 'found' ? slots.found[to.idx] : slots.tab[to.idx];
  }

  function showHint() {
    if (busy || meta.won) return;
    clearHint();
    const hints = findHints();
    if (!hints.length) {
      toast('No moves left — try Undo or deal a new game');
      return;
    }
    const h = hints[hintIndex % hints.length];
    hintIndex++;
    if (h.draw) {
      (state.stock.length ? els[last(state.stock)] : slots.stock).classList.add('hint');
    } else {
      h.ids.forEach(id => els[id].classList.add('hint'));
      targetEl(h.to).classList.add('hint-target');
    }
    toast(describe(h) + (hints.length > 1 ? '  ·  press again for another' : ''));
    hintTimer = setTimeout(clearHint, 2600);
  }

  function clearHint() {
    clearTimeout(hintTimer);
    board.querySelectorAll('.hint, .hint-target').forEach(el => el.classList.remove('hint', 'hint-target'));
  }

  // ---------- Layout & rendering ----------

  const colX = c => c * (L.cw + L.gap);

  function layout() {
    const hudH = hud.getBoundingClientRect().height;
    // Measure the body rather than the window so phone safe-area padding is respected.
    const availW = Math.min(document.body.clientWidth - 32, 1180);
    const availH = document.body.clientHeight - hudH - 12;
    const gapR = 0.16;
    let cw = availW / (7 + 6 * gapR);
    cw = Math.min(cw, 128, availH / 1.4 / 3.6);
    cw = Math.floor(Math.max(cw, 36));
    const ch = Math.round(cw * 1.4);
    const gap = Math.round(cw * gapR);
    const top = 6;
    L = { cw, ch, gap, top, w: 7 * cw + 6 * gap, h: availH, tabY: top + ch + Math.max(Math.round(gap * 1.6), 14) };

    board.style.width = L.w + 'px';
    board.style.height = L.h + 'px';
    board.style.setProperty('--cw', cw + 'px');
    board.style.setProperty('--ch', ch + 'px');

    const place = (el, x, y) => { el.style.transform = `translate(${x}px, ${y}px)`; };
    place(slots.stock, 0, top);
    place(slots.track, colX(1), top);
    slots.track.style.width = colX(3) - colX(1) - gap + 'px';
    slots.found.forEach((el, f) => place(el, colX(3 + f), top));
    slots.tab.forEach((el, c) => place(el, colX(c), L.tabY));
    place(slots.badge, cw - 18, top - 9);
  }

  function computePositions() {
    const out = {};
    const { cw, ch, top } = L;

    state.stock.forEach((id, i) => {
      const t = Math.floor(i / 4);
      out[id] = { x: -t, y: top - t, z: 10 + i, down: true, key: 's' };
    });

    // Draw row: the newest three are fanned wide, older cards squeeze in behind them.
    const n = state.waste.length;
    const k = Math.min(n, 3);
    const m = n - k;
    const avail = colX(3) - colX(1) - L.gap;
    const big = cw * 0.3;
    const small = m ? Math.min(cw * 0.13, Math.max(0, (avail - cw - (k - 1) * big) / m)) : 0;
    state.waste.forEach((id, i) => {
      const x = Math.round(colX(1) + (i <= m ? i * small : m * small + (i - m) * big));
      out[id] = { x, y: top, z: 100 + i, down: false, key: 'w' };
    });

    if (state.free !== null) out[state.free] = { x: 0, y: top, z: 60, down: false, key: 'free' };

    state.foundations.forEach((f, fi) => {
      f.forEach((id, i) => {
        out[id] = { x: colX(3 + fi), y: top, z: 200 + i, down: false, key: 'f' + fi };
      });
    });

    const room = L.h - L.tabY - ch - 8;
    state.tableau.forEach((col, c) => {
      let off = ch * 0.27;
      if (col.length > 1) off = Math.max(ch * 0.1, Math.min(off, room / (col.length - 1)));
      let runStart = col.length - 1;
      while (runStart > 0 && fits(col[runStart], col[runStart - 1])) runStart--;
      col.forEach((id, i) => {
        out[id] = { x: colX(c), y: Math.round(L.tabY + i * off), z: 400 + i, down: false, key: 't' + c, locked: i < runStart };
      });
    });
    state.waste.forEach((id, i) => { out[id].locked = i < state.waste.length - 1; });
    return out;
  }

  function setCardZ(el, z, boostFor) {
    el._z = z;
    if (boostFor) {
      el.style.zIndex = 3000 + z;
      clearTimeout(el._zt);
      el._zt = setTimeout(() => { el.style.zIndex = el._z; el._zt = null; }, boostFor);
    } else if (!el._zt) {
      el.style.zIndex = z;
    }
  }

  // Cards rest as flat 2D layers (3D layers can show seam lines in Chrome). A card that
  // turns over is switched into 3D mode at its current side first, then flipped, and
  // flattened again once the turn is done.
  function prepareFlips(flips) {
    if (!flips.length) return;
    for (const { el } of flips) {
      el.firstChild.style.transition = 'none';
      el.classList.add('flip3d');
    }
    void board.offsetWidth;
    for (const { el, down, delay } of flips) {
      el.firstChild.style.transition = '';
      el.classList.toggle('down', down);
      clearTimeout(el._ft);
      el._ft = setTimeout(() => el.classList.remove('flip3d'), 2000 + delay); // backstop for the transitionend below
    }
  }

  board.addEventListener('transitionend', e => {
    if (e.propertyName !== 'transform' || !e.target.classList.contains('inner')) return;
    const el = e.target.parentElement;
    clearTimeout(el._ft);
    el.classList.remove('flip3d');
  });

  function render({ instant = false, stagger = null, boost = null } = {}) {
    P = computePositions();
    if (instant) board.classList.add('no-anim');
    const flips = [];
    for (const c of CARDS) {
      const el = els[c.id];
      const p = P[c.id];
      const delay = stagger ? (stagger[c.id] || 0) : 0;
      el.style.transitionDelay = el.firstChild.style.transitionDelay = delay ? delay + 'ms' : '';
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      if (instant || el.classList.contains('down') === p.down) el.classList.toggle('down', p.down);
      else flips.push({ el, down: p.down, delay });
      el.classList.toggle('locked', DIM_LOCKED && !!p.locked);
      const moved = el._key !== p.key || (boost && boost.has(c.id)) || delay;
      if (instant) {
        clearTimeout(el._zt);
        el._zt = null;
        setCardZ(el, p.z, 0);
      } else {
        setCardZ(el, p.z, moved ? 420 + delay : 0);
      }
      el._key = p.key;
    }
    prepareFlips(flips);

    slots.stock.classList.toggle('free-cell', freeActive());
    slots.badge.textContent = state.stock.length;
    slots.badge.style.opacity = state.stock.length ? 1 : 0;

    if (instant) {
      void board.offsetWidth;
      board.classList.remove('no-anim');
    }
  }

  function dealAnimation() {
    busy = true;
    board.classList.add('no-anim');
    for (const c of CARDS) {
      const el = els[c.id];
      el.style.transition = '';
      el.style.transform = `translate(0px, ${L.top}px)`;
      el.classList.add('down');
      el.classList.remove('flip3d');
      clearTimeout(el._ft);
      clearTimeout(el._zt);
      el._zt = null;
      el.style.zIndex = 10 + c.id;
      el._key = 's';
    }
    void board.offsetWidth;
    board.classList.remove('no-anim');

    const stagger = {};
    let k = 0;
    for (let row = 0; row < 7; row++) {
      for (let c = row; c < 7; c++) stagger[state.tableau[c][row]] = 120 + (k++) * 42;
    }
    render({ stagger });
    setTimeout(() => {
      for (const c of CARDS) els[c.id].style.transitionDelay = els[c.id].firstChild.style.transitionDelay = '';
      busy = false;
      autoPlay(AUTO_BEAT); // the deal's flips have finished by now
    }, 120 + k * 42 + 520);
  }

  // ---------- Building the DOM ----------

  function cardHTML(c) {
    const r = RANKS[c.rank - 1];
    const s = suitSVG(c.suit);
    let center;
    if (c.rank === 1) center = `<div class="center ace"><span>${s}</span></div>`;
    else if (c.rank > 10) center = `<div class="center court"><span class="cl${c.rank < 13 ? ' desc' : ''}">${r}</span></div>`;
    else center = `<div class="center pip"><span>${s}</span></div>`;
    const idx = pos => `<div class="idx ${pos}"><span class="r">${r}</span><span class="s">${s}</span></div>`;
    return `<div class="inner"><div class="face">${idx('top')}${center}${idx('bot')}</div><div class="back"></div></div>`;
  }

  function makeSlot(cls, html = '') {
    const el = document.createElement('div');
    el.className = 'slot ' + cls;
    el.innerHTML = html;
    board.appendChild(el);
    return el;
  }

  function build() {
    slots.stock = makeSlot('stock', '<span class="free-label">Free<br>cell</span><span class="empty-ico">◇</span>');
    slots.track = makeSlot('track', '<span>Draw row</span>');
    slots.found = SUITS.map((s, i) => makeSlot('found ' + s.color, `<span>${suitSVG(i)}</span>`));
    slots.tab = Array.from({ length: 7 }, () => makeSlot('tab'));
    slots.badge = document.createElement('div');
    slots.badge.className = 'badge';
    board.appendChild(slots.badge);

    for (const c of CARDS) {
      const el = document.createElement('div');
      el.className = `card ${c.color} down`;
      el.dataset.id = c.id;
      el.setAttribute('aria-label', `${RANKS[c.rank - 1]} of ${SUITS[c.suit].name}`);
      el.innerHTML = cardHTML(c);
      board.appendChild(el);
      els[c.id] = el;
    }
  }

  // ---------- Pointer input ----------

  function overlap(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  }

  function findTarget(d) {
    const r = { x: d.base[0].x + d.dx, y: d.base[0].y + d.dy, w: L.cw, h: L.ch };
    let best = null;
    let bestArea = 0;
    const consider = (to, rect) => {
      if (!canDrop(d.ids, d.from, to)) return;
      const a = overlap(r, rect);
      if (a > bestArea) { bestArea = a; best = to; }
    };
    state.tableau.forEach((col, c) => {
      const y = col.length ? P[last(col)].y : L.tabY;
      consider({ type: 'tableau', idx: c }, { x: colX(c), y, w: L.cw, h: L.ch * 1.5 });
    });
    for (let f = 0; f < 4; f++) consider({ type: 'found', idx: f }, { x: colX(3 + f), y: L.top, w: L.cw, h: L.ch });
    consider({ type: 'free' }, { x: 0, y: L.top, w: L.cw, h: L.ch });
    return best;
  }

  function setDropHighlight(to) {
    const el = to ? targetEl(to) : null;
    if (el === dropEl) return;
    if (dropEl) dropEl.classList.remove('drop-ok');
    dropEl = el;
    if (el) el.classList.add('drop-ok');
  }

  board.addEventListener('pointerdown', e => {
    if (busy || meta.won || drag || e.button > 0) return;
    const el = e.target.closest('.card');
    if (!el) return;
    const id = +el.dataset.id;
    const loc = locate(id);
    if (loc.type === 'stock') {
      draw();
      return;
    }
    const ids = grab(loc);
    if (!ids) {
      shake([id]);
      return;
    }
    e.preventDefault();
    drag = {
      pointer: e.pointerId, ids, from: loc,
      sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, moved: false,
      base: ids.map(i => ({ x: P[i].x, y: P[i].y })),
    };
    board.setPointerCapture(e.pointerId);
  });

  board.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      clearHint();
      drag.ids.forEach((id, k) => {
        const el = els[id];
        el.classList.add('dragging');
        clearTimeout(el._zt);
        el._zt = null;
        el.style.zIndex = 5000 + k;
      });
    }
    drag.dx = dx;
    drag.dy = dy;
    drag.ids.forEach((id, k) => {
      els[id].style.transform = `translate(${Math.round(drag.base[k].x + dx)}px, ${Math.round(drag.base[k].y + dy)}px)`;
    });
    setDropHighlight(findTarget(drag));
  });

  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const d = drag;
    drag = null;
    d.ids.forEach(id => els[id].classList.remove('dragging'));
    setDropHighlight(null);
    if (!d.moved) {
      if (!cancelled) clickMove(d.from, d.ids);
      return;
    }
    const to = cancelled ? null : findTarget(d);
    if (to) move(d.from, d.ids, to);
    else render({ boost: new Set(d.ids) });
  }

  board.addEventListener('pointerup', e => endDrag(e, false));
  board.addEventListener('pointercancel', e => endDrag(e, true));

  // ---------- Feedback ----------

  function shake(ids) {
    ids.forEach(id => {
      const el = els[id];
      el.classList.remove('shake');
      void el.offsetWidth;
      el.classList.add('shake');
      setTimeout(() => el.classList.remove('shake'), 400);
    });
  }

  function bump(el) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- HUD & clock ----------

  function elapsed() {
    return clock.acc + (clock.since === null ? 0 : Date.now() - clock.since);
  }

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  function updateHud() {
    $('#wins').textContent = stats.wins;
    $('#moves').textContent = state.moves;
    $('#time').textContent = fmtTime(elapsed());
    $('#btn-undo').disabled = !history.length || meta.won;
    // While safe auto-play still has a card to send home, it's about to move on its own.
    const autoPending = settings.autoSafe && !!nextFoundationMove(state, isSafeHome);
    $('#btn-auto').classList.toggle('hidden', busy || autoPending || !canAutoFinish());
  }

  // ---------- Winning ----------

  function checkWin() {
    if (meta.won || foundCount() < 52) return;
    meta.won = true;
    clock.acc = elapsed();
    clock.since = null;
    stats.wins++;
    if (!stats.best || clock.acc < stats.best) stats.best = clock.acc;
    saveStats();
    updateHud();
    bump($('#wins'));
    celebrate();
  }

  function celebrate() {
    busy = true;
    clearHint();
    winTimers.push(setTimeout(() => {
      const order = [];
      for (let r = 12; r >= 0; r--) for (let f = 0; f < 4; f++) order.push(state.foundations[f][r]);
      order.forEach((id, i) => {
        const el = els[id];
        const x = Math.random() * (L.w - L.cw);
        const y = Math.random() * (L.h - L.ch);
        const rot = (Math.random() - 0.5) * 90;
        el.style.transition = `transform 1.1s cubic-bezier(.2,.8,.2,1) ${i * 26}ms`;
        el.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${rot}deg)`;
        clearTimeout(el._zt);
        el._zt = null;
        el.style.zIndex = 3000 + i;
      });
      winTimers.push(setTimeout(showWinModal, 1500));
    }, 450));
  }

  function showWinModal() {
    openModal(`
      <div class="win-panel">
        <h2>Victory</h2>
        <p class="sub">Every suit is home, ace to king.</p>
        <div class="win-stats">
          <div><b>${state.moves}</b><span>Moves</span></div>
          <div><b>${fmtTime(meta.elapsed || clock.acc)}</b><span>Time</span></div>
          <div><b>${stats.wins}</b><span>Total wins</span></div>
          <div><b>${stats.best ? fmtTime(stats.best) : '—'}</b><span>Best time</span></div>
        </div>
        <div class="row"><button class="btn gold" data-action="new-force">Deal again</button></div>
      </div>`);
    confetti();
  }

  function confetti() {
    const colors = ['#ecd396', '#d4af5f', '#c4314b', '#fbf6ea', '#7ef0c5'];
    for (let i = 0; i < 90; i++) {
      const p = document.createElement('div');
      p.className = 'confetti';
      p.style.left = Math.random() * 100 + 'vw';
      p.style.background = colors[i % colors.length];
      p.style.animationDuration = 2.4 + Math.random() * 2.4 + 's';
      p.style.animationDelay = Math.random() * 0.8 + 's';
      p.style.setProperty('--dx', (Math.random() - 0.5) * 300 + 'px');
      p.style.setProperty('--rot', (Math.random() - 0.5) * 1440 + 'deg');
      if (i % 3 === 0) p.style.borderRadius = '50%';
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 6000);
    }
  }

  // ---------- Modals ----------

  function openModal(html) {
    modal.querySelector('.panel').innerHTML = html;
    modal.classList.remove('hidden');
    requestAnimationFrame(() => modal.classList.add('show'));
  }

  function closeModal() {
    modal.classList.remove('show');
    setTimeout(() => { if (!modal.classList.contains('show')) modal.classList.add('hidden'); }, 260);
  }

  const modalOpen = () => !modal.classList.contains('hidden');

  function showRules() {
    openModal(`
      <button class="close-x" data-action="close" aria-label="Close">✕</button>
      <h2>How to play</h2>
      <p class="sub">Klondike's layout with nothing hidden — every card is face up from the start.</p>
      <h3>Goal</h3>
      <ul><li>Build all four foundations, one per suit, from Ace up to King.</li></ul>
      <h3>The table</h3>
      <ul>
        <li>Seven columns are dealt Klondike-style (1 to 7 cards), all face up. The other 24 cards form the deck.</li>
        <li>Stack cards in the columns in descending rank with alternating colours (red on black, black on red).</li>
        <li>An ordered run can be moved together. Any card or run may be placed into an empty column.</li>
        <li>Once a card is on a foundation it stays there — it can't be taken back.</li>
      </ul>
      <h3>The deck</h3>
      <ul>
        <li>Draw three cards at any time — they join the draw row at the top. Only the rightmost card in the row can be played.</li>
        <li>There is no redeal. Once the deck is used up, its spot becomes a free cell that holds exactly one card.</li>
      </ul>
      <h3>Controls</h3>
      <ul>
        <li>Drag cards to move them, or tap a card to send it to the best legal spot.</li>
        <li><kbd>Space</kbd> draw · <kbd>Z</kbd> undo · <kbd>H</kbd> hint · <kbd>N</kbd> new game · <kbd>R</kbd> rules</li>
      </ul>
      <h3>Settings</h3>
      <label class="toggle">
        <input type="checkbox" data-setting="autoSafe"${settings.autoSafe ? ' checked' : ''}>
        <span class="switch" aria-hidden="true"></span>
        <span><b>Auto-play safe cards</b><small>Sends a card home automatically once nothing could still need it in the columns. This never turns a winnable game into a lost one.</small></span>
      </label>
      <h3>Your record</h3>
      <ul><li>${stats.wins} win${stats.wins === 1 ? '' : 's'} from ${stats.played} game${stats.played === 1 ? '' : 's'} played${stats.best ? ` · best time ${fmtTime(stats.best)}` : ''}.</li></ul>
      <div class="row"><button class="btn gold" data-action="close">Let's play</button></div>`);
  }

  function newGame(force = false) {
    if (!force && !meta.won && state.moves > 0) {
      openModal(`
        <h2>New game?</h2>
        <p class="sub">The current game will be abandoned.</p>
        <div class="row">
          <button class="btn" data-action="close">Keep playing</button>
          <button class="btn gold" data-action="new-force">Deal new game</button>
        </div>`);
      return;
    }
    if (modalOpen()) closeModal();
    winTimers.forEach(clearTimeout);
    winTimers = [];
    stopAutoPlay();
    clearHint();
    state = freshState();
    history = [];
    meta = { counted: false, won: false, elapsed: 0 };
    clock.acc = 0;
    clock.since = null;
    hintIndex = 0;
    dealAnimation();
    updateHud();
    save();
  }

  modal.addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'close') closeModal();
    else if (action === 'new-force') newGame(true);
    else if (e.target === modal) closeModal();
  });

  modal.addEventListener('change', e => {
    const key = e.target.dataset.setting;
    if (!key) return;
    settings[key] = e.target.checked;
    saveSettings();
    if (key === 'autoSafe') {
      if (settings.autoSafe) autoPlay();
      else stopAutoPlay();
      updateHud();
    }
  });

  // ---------- Wiring ----------

  $('#btn-new').addEventListener('click', () => newGame());
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-hint').addEventListener('click', showHint);
  $('#btn-rules').addEventListener('click', showRules);
  $('#btn-auto').addEventListener('click', autoFinish);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modalOpen()) {
      closeModal();
      return;
    }
    if (modalOpen() || e.altKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (e.ctrlKey) return;
    else if (key === 'h') showHint();
    else if (key === 'n') newGame();
    else if (key === 'r') showRules();
    else if (key === ' ' || key === 'd') { e.preventDefault(); draw(); }
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      layout();
      if (!meta.won) render({ instant: true });
    }, 80);
  });

  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

  // ---------- Start ----------

  function validSaved(saved) {
    if (!saved || !saved.state || !saved.meta || saved.meta.won) return false;
    const s = saved.state;
    const all = [...s.stock, ...s.waste, ...s.foundations.flat(), ...s.tableau.flat()];
    if (s.free !== null) all.push(s.free);
    return all.length === 52 && new Set(all).size === 52;
  }

  function init() {
    stats = Object.assign({ wins: 0, played: 0, best: null }, load(STATS_KEY, {}));
    settings = Object.assign({ autoSafe: true }, load(SETTINGS_KEY, {}));
    build();
    layout();
    const saved = load(GAME_KEY, null);
    let ok = false;
    try { ok = validSaved(saved); } catch { ok = false; }
    if (ok) {
      state = saved.state;
      history = saved.history || [];
      meta = saved.meta;
      clock.acc = meta.elapsed || 0;
      clock.since = meta.counted ? Date.now() : null;
      render({ instant: true });
      updateHud();
      autoPlay();
    } else {
      state = freshState();
      meta = { counted: false, won: false, elapsed: 0 };
      newGame(true);
      if (!stats.played) setTimeout(showRules, 1600);
    }
    setInterval(() => { $('#time').textContent = fmtTime(elapsed()); }, 1000);
  }

  init();
})();
