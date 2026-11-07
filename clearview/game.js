(() => {
  'use strict';

  const { SUITS, TEXT_STYLE, suitSVG, last, same, place, shuffle } = Solitaire;

  // ---------- Card data ----------

  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const CARDS = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 1; r <= 13; r++) CARDS.push({ id: CARDS.length, suit: s, rank: r, color: SUITS[s].color });
  }

  const DRAW_COUNT = 3;
  const DIM_LOCKED = true; // darken cards buried under ones that can be played
  const AUTO_BEAT = 400;        // ms pause after a card turns over, before it's auto-played
  const AUTO_AFTER_FLIP = 500 + AUTO_BEAT; // the flip itself takes 0.5s

  const $ = sel => document.querySelector(sel);

  let G; // the shared engine's table: G.state is { stock, waste, free, foundations[4], tableau[7], moves }

  // ---------- Rules helpers ----------

  const card = id => CARDS[id];
  const nameOf = id => RANKS[card(id).rank - 1] + SUITS[card(id).suit].sym + TEXT_STYLE;
  const freeActive = () => G.state.stock.length === 0;
  const foundCount = () => G.state.foundations.reduce((n, f) => n + f.length, 0);

  // Can `lower` be placed directly onto `upper` in the tableau?
  const fits = (lower, upper) =>
    card(upper).rank === card(lower).rank + 1 && card(upper).color !== card(lower).color;

  const canFound = id => card(id).rank === G.state.foundations[card(id).suit].length + 1;

  function isRun(col, from) {
    for (let j = from + 1; j < col.length; j++) if (!fits(col[j], col[j - 1])) return false;
    return true;
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
    const state = G.state;
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

  function pileOf(ref, s = G.state) {
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
      const col = G.state.tableau[to.idx];
      return !col.length || fits(first, last(col));
    }
    if (to.type === 'found') {
      return ids.length === 1 && card(first).suit === to.idx && canFound(first);
    }
    if (to.type === 'free') return ids.length === 1 && freeActive() && G.state.free === null;
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

  function draw() {
    const state = G.state;
    if (G.busy || G.meta.won || !state.stock.length) return;
    G.snapshot();
    const n = Math.min(DRAW_COUNT, state.stock.length);
    for (let i = 0; i < n; i++) state.waste.push(state.stock.pop());
    state.moves++;
    G.committed(false, false, AUTO_AFTER_FLIP);
    G.bump(G.slots.badge);
    if (!state.stock.length) setTimeout(() => G.toast('Deck exhausted — its spot is now a free cell'), 400);
  }

  // Click / tap: the best legal spot for the card (and its run).
  function clickTarget(from, ids) {
    const state = G.state;
    const tries = [];
    if (ids.length === 1) tries.push({ type: 'found', idx: card(ids[0]).suit });
    for (let c = 0; c < 7; c++) if (state.tableau[c].length) tries.push({ type: 'tableau', idx: c });
    if (!(from.type === 'tableau' && from.pos === 0)) {
      const empty = state.tableau.findIndex(col => !col.length);
      if (empty >= 0) tries.push({ type: 'tableau', idx: empty });
    }
    if (from.type === 'waste' || from.type === 'tableau') tries.push({ type: 'free' });
    return tries.find(t => canDrop(ids, from, t)) || null;
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
  function isSafeHome(id, s = G.state) {
    const { rank, suit } = card(id);
    const f = s.foundations;
    if (rank !== f[suit].length + 1) return false;
    const opp = Math.min(f[(suit + 1) % 4].length, f[(suit + 3) % 4].length);
    const twin = f[(suit + 2) % 4].length;
    return opp >= rank - 1 || (opp >= rank - 2 && twin >= rank - 3);
  }

  function nextAuto() {
    const m = G.settings.autoSafe && nextFoundationMove(G.state, isSafeHome);
    return m ? () => put(G.state, m.to, take(G.state, m.from, 1)) : null;
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
    if (G.meta.won || G.state.stock.length || foundCount() === 52) return false;
    const s = JSON.parse(JSON.stringify(G.state));
    let m;
    while ((m = nextFoundationMove(s))) put(s, m.to, take(s, m.from, 1));
    return s.foundations.every(f => f.length === 13);
  }

  function autoFinish() {
    if (G.busy || !canAutoFinish()) return;
    G.busy = true;
    $('#btn-auto').classList.add('hidden');
    let done = 0;
    const step = () => {
      const m = nextFoundationMove(G.state);
      if (!m) {
        G.busy = false;
        G.updateHud();
        return;
      }
      G.move(m.from, m.ids, m.to);
      if (!G.meta.won) setTimeout(step, Solitaire.paced(115, done++)); // speeds up as it goes; on a win the celebration takes over
    };
    step();
  }

  // ---------- Hints ----------

  function findHints() {
    const state = G.state;
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

    if (state.stock.length) out.push({ draw: true, el: G.els[last(state.stock)], score: 20 });
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
    if (to.type === 'free') return G.slots.stock;
    const pile = pileOf(to);
    if (pile.length) return G.els[last(pile)];
    return to.type === 'found' ? G.slots.found[to.idx] : G.slots.tab[to.idx];
  }

  // ---------- Layout & rendering ----------

  const colX = c => c * (G.L.cw + G.L.gap);

  function layout(availW, availH) {
    const gapR = 0.16;
    let cw = availW / (7 + 6 * gapR);
    cw = Math.min(cw, 128, availH / 1.4 / 3.6);
    cw = Math.floor(Math.max(cw, 36));
    const ch = Math.round(cw * 1.4);
    const gap = Math.round(cw * gapR);
    const top = 6;
    G.L = { cw, ch, gap, top, w: 7 * cw + 6 * gap, h: availH, tabY: top + ch + Math.max(Math.round(gap * 1.6), 14) };

    const { slots } = G;
    place(slots.stock, 0, top);
    place(slots.track, colX(1), top);
    slots.track.style.width = colX(3) - colX(1) - gap + 'px';
    slots.found.forEach((el, f) => place(el, colX(3 + f), top));
    slots.tab.forEach((el, c) => place(el, colX(c), G.L.tabY));
    place(slots.badge, cw - 18, top - 9);
  }

  function positions() {
    const state = G.state;
    const out = {};
    const { cw, ch, top } = G.L;

    state.stock.forEach((id, i) => {
      const t = Math.floor(i / 4);
      out[id] = { x: -t, y: top - t, z: 10 + i, down: true, key: 's' };
    });

    // Draw row: the newest three are fanned wide, older cards squeeze in behind them.
    const n = state.waste.length;
    const k = Math.min(n, 3);
    const m = n - k;
    const avail = colX(3) - colX(1) - G.L.gap;
    const big = cw * 0.3;
    const small = m ? Math.min(cw * 0.13, Math.max(0, (avail - cw - (k - 1) * big) / m)) : 0;
    state.waste.forEach((id, i) => {
      const x = Math.round(colX(1) + (i <= m ? i * small : m * small + (i - m) * big));
      out[id] = { x, y: top, z: 100 + i, down: false, key: 'w', locked: DIM_LOCKED && i < n - 1 };
    });

    if (state.free !== null) out[state.free] = { x: 0, y: top, z: 60, down: false, key: 'free' };

    state.foundations.forEach((f, fi) => {
      f.forEach((id, i) => {
        out[id] = { x: colX(3 + fi), y: top, z: 200 + i, down: false, key: 'f' + fi };
      });
    });

    const room = G.L.h - G.L.tabY - ch - 8;
    state.tableau.forEach((col, c) => {
      let off = ch * 0.27;
      if (col.length > 1) off = Math.max(ch * 0.1, Math.min(off, room / (col.length - 1)));
      let runStart = col.length - 1;
      while (runStart > 0 && fits(col[runStart], col[runStart - 1])) runStart--;
      col.forEach((id, i) => {
        out[id] = { x: colX(c), y: Math.round(G.L.tabY + i * off), z: 400 + i, down: false, key: 't' + c, locked: DIM_LOCKED && i < runStart };
      });
    });
    return out;
  }

  function afterRender() {
    const { slots, state } = G;
    slots.stock.classList.toggle('free-cell', freeActive());
    slots.badge.textContent = state.stock.length;
    slots.badge.style.opacity = state.stock.length ? 1 : 0;
  }

  function dropZones() {
    const { L, P, state } = G;
    const zones = state.tableau.map((col, c) => ({
      to: { type: 'tableau', idx: c },
      x: colX(c), y: col.length ? P[last(col)].y : L.tabY, w: L.cw, h: L.ch * 1.5,
    }));
    for (let f = 0; f < 4; f++) zones.push({ to: { type: 'found', idx: f }, x: colX(3 + f), y: L.top, w: L.cw, h: L.ch });
    zones.push({ to: { type: 'free' }, x: 0, y: L.top, w: L.cw, h: L.ch });
    return zones;
  }

  function dealOrder() {
    const order = [];
    for (let row = 0; row < 7; row++) {
      for (let c = row; c < 7; c++) order.push(G.state.tableau[c][row]);
    }
    return order;
  }

  // ---------- Building the DOM ----------

  function faceHTML(c) {
    const r = RANKS[c.rank - 1];
    const s = suitSVG(c.suit);
    let center;
    if (c.rank === 1) center = `<div class="center ace"><span>${s}</span></div>`;
    else if (c.rank > 10) center = `<div class="center court"><span class="cl${c.rank < 13 ? ' desc' : ''}">${r}</span></div>`;
    else center = `<div class="center pip"><span>${s}</span></div>`;
    const idx = pos => `<div class="idx ${pos}"><span class="r">${r}</span><span class="s">${s}</span></div>`;
    return `${idx('top')}${center}${idx('bot')}`;
  }

  function buildSlots() {
    const { slots, board } = G;
    slots.stock = G.makeSlot('stock', '<span class="free-label">Free<br>cell</span><span class="empty-ico">◇</span>');
    slots.track = G.makeSlot('track', '<span>Draw row</span>');
    slots.found = SUITS.map((s, i) => G.makeSlot('found ' + s.color, `<span>${suitSVG(i)}</span>`));
    slots.tab = Array.from({ length: 7 }, () => G.makeSlot('tab'));
    slots.badge = document.createElement('div');
    slots.badge.className = 'badge';
    board.appendChild(slots.badge);
  }

  // ---------- HUD, rules & settings ----------

  function updateHud() {
    // While safe auto-play still has a card to send home, it's about to move on its own.
    const autoPending = G.settings.autoSafe && !!nextFoundationMove(G.state, isSafeHome);
    $('#btn-auto').classList.toggle('hidden', G.busy || autoPending || !canAutoFinish());
  }

  function validState(s) {
    const all = [...s.stock, ...s.waste, ...s.foundations.flat(), ...s.tableau.flat()];
    if (s.free !== null) all.push(s.free);
    return all.length === 52 && new Set(all).size === 52;
  }

  function winOrder() {
    const order = [];
    for (let r = 12; r >= 0; r--) for (let f = 0; f < 4; f++) order.push(G.state.foundations[f][r]);
    return order;
  }

  const rulesHTML = () => `
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
      <li><kbd>Space</kbd> draw · <kbd>Z</kbd> undo · <kbd>H</kbd> hint · <kbd>N</kbd> new game · <kbd>R</kbd> rules · <kbd>S</kbd> settings</li>
    </ul>`;

  const settingsHTML = () => `
    <label class="toggle">
      <input type="checkbox" data-setting="autoSafe"${G.settings.autoSafe ? ' checked' : ''}>
      <span class="switch" aria-hidden="true"></span>
      <span><b>Auto-play safe cards</b><small>Sends a card home automatically once nothing could still need it in the columns. This never turns a winnable game into a lost one.</small></span>
    </label>`;

  function onSetting(key) {
    if (key !== 'autoSafe') return;
    if (G.settings.autoSafe) G.autoPlay();
    else G.stopAutoPlay();
    G.updateHud();
  }

  // ---------- Start ----------

  G = Solitaire.createGame({
    id: 'clearview',
    cards: CARDS,
    cardLabel: c => `${RANKS[c.rank - 1]} of ${SUITS[c.suit].name}`,
    faceHTML,
    buildSlots,
    layout,
    positions,
    afterRender,
    freshState,
    validState,
    isWon: () => foundCount() === 52,
    winOrder,
    winText: 'Every suit is home, ace to king.',
    locate,
    grab,
    canDrop,
    apply: (s, from, ids, to) => put(s, to, take(s, from, ids.length)),
    dropZones,
    targetEl,
    clickTarget,
    findHints,
    describe,
    dealOrder,
    dealFrom: () => ({ x: 0, y: G.L.top, key: 's' }),
    nextAuto,
    afterDealWait: AUTO_BEAT,
    press: (id, loc) => {
      if (loc.type !== 'stock') return false;
      draw();
      return true;
    },
    updateHud,
    onKey: (key, e) => {
      if (key !== ' ' && key !== 'd') return;
      e.preventDefault();
      draw();
    },
    wire: () => $('#btn-auto').addEventListener('click', autoFinish),
    rulesHTML,
    settingsDefaults: { autoSafe: true },
    settingsHTML,
    onSetting,
  });

  G.start();
})();
