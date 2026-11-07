(() => {
  'use strict';

  const { SUITS, TEXT_STYLE, suitSVG, last, same, place, shuffle } = Solitaire;

  // ---------- Card data ----------

  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const CARDS = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 1; r <= 13; r++) CARDS.push({ id: CARDS.length, suit: s, rank: r, color: SUITS[s].color });
  }

  const COLS = 8;
  const CELLS = 4;
  // Play a run's move out card by card through the free cells (see moveSteps). Off for now: a
  // run moves across in one go.
  const SHOW_RUN_STEPS = false;

  const $ = sel => document.querySelector(sel);

  // The shared engine's table. G.state is { cells[4], foundations[4], tableau[8], moves }:
  // an empty free cell holds null.
  let G;

  // ---------- Rules helpers ----------

  const card = id => CARDS[id];
  const nameOf = id => RANKS[card(id).rank - 1] + SUITS[card(id).suit].sym + TEXT_STYLE;
  const foundCount = (s = G.state) => s.foundations.reduce((n, f) => n + f.length, 0);

  // Can `lower` be placed directly onto `upper` in the tableau?
  const fits = (lower, upper) =>
    card(upper).rank === card(lower).rank + 1 && card(upper).color !== card(lower).color;

  const canFound = (id, s = G.state) => card(id).rank === s.foundations[card(id).suit].length + 1;

  function isRun(col, from) {
    for (let j = from + 1; j < col.length; j++) if (!fits(col[j], col[j - 1])) return false;
    return true;
  }

  // How many cards can move as one run: each free cell doubles as a resting spot for one card,
  // and each empty column doubles the lot. A column being moved into doesn't count as spare.
  function capacity(toEmpty, s = G.state) {
    const cells = s.cells.filter(c => c === null).length;
    const empties = s.tableau.filter(col => !col.length).length - (toEmpty ? 1 : 0);
    return (cells + 1) * 2 ** Math.max(0, empties);
  }

  function freshState() {
    const deck = shuffle([...Array(52).keys()]);
    const tableau = Array.from({ length: COLS }, () => []);
    deck.forEach((id, k) => tableau[k % COLS].push(id));
    return { cells: Array(CELLS).fill(null), foundations: [[], [], [], []], tableau, moves: 0 };
  }

  function locate(id) {
    const state = G.state;
    let i;
    if ((i = state.cells.indexOf(id)) >= 0) return { type: 'cell', idx: i, pos: 0 };
    for (let f = 0; f < 4; f++) {
      if ((i = state.foundations[f].indexOf(id)) >= 0) return { type: 'found', idx: f, pos: i };
    }
    for (let c = 0; c < COLS; c++) {
      if ((i = state.tableau[c].indexOf(id)) >= 0) return { type: 'tableau', idx: c, pos: i };
    }
    return null;
  }

  function pileOf(ref, s = G.state) {
    switch (ref.type) {
      case 'cell': return s.cells[ref.idx] === null ? [] : [s.cells[ref.idx]];
      case 'found': return s.foundations[ref.idx];
      case 'tableau': return s.tableau[ref.idx];
    }
    return [];
  }

  // The cards that come along when picking up the card at `loc`, or null if it can't be picked up.
  // Cards that reach a foundation stay there.
  function grab(loc) {
    if (loc.type === 'found') return null;
    if (loc.type === 'cell') return [G.state.cells[loc.idx]];
    const col = G.state.tableau[loc.idx];
    return isRun(col, loc.pos) ? col.slice(loc.pos) : null;
  }

  function canDrop(ids, from, to) {
    if (same(from, to)) return false;
    const first = ids[0];
    if (to.type === 'cell') return ids.length === 1 && G.state.cells[to.idx] === null;
    if (to.type === 'found') return ids.length === 1 && card(first).suit === to.idx && canFound(first);
    const col = G.state.tableau[to.idx];
    if (!col.length) return ids.length <= capacity(true);
    return fits(first, last(col)) && ids.length <= capacity(false);
  }

  function take(s, from, count) {
    if (from.type === 'cell') {
      const id = s.cells[from.idx];
      s.cells[from.idx] = null;
      return [id];
    }
    const pile = pileOf(from, s);
    return pile.splice(pile.length - count, count);
  }

  function put(s, to, ids) {
    if (to.type === 'cell') s.cells[to.idx] = ids[0];
    else pileOf(to, s).push(...ids);
  }

  // A run really moves one card at a time. Spell out those steps so the engine can play them:
  // park all but the run's bottom card in free cells, move it, then bring the rest back down on
  // top. A run too long for the cells alone goes in parts, with an empty column holding one part
  // while the next goes across.
  function moveSteps(from, ids, to) {
    if (ids.length < 2) return null;
    const s = JSON.parse(JSON.stringify(G.state));
    const steps = [];
    const tab = idx => ({ type: 'tableau', idx });
    const step = (f, t) => {
      steps.push({ from: f, ids: [last(pileOf(f, s))], to: t });
      put(s, t, take(s, f, 1));
    };
    const shift = (n, src, dst, spare) => {
      const cells = s.cells.map((id, i) => (id === null ? i : -1)).filter(i => i >= 0);
      if (n <= cells.length + 1 || !spare.length) {
        const used = cells.slice(0, n - 1);
        used.forEach(i => step(tab(src), { type: 'cell', idx: i }));
        step(tab(src), tab(dst));
        used.reverse().forEach(i => step({ type: 'cell', idx: i, pos: 0 }, tab(dst)));
        return;
      }
      const [via, ...rest] = spare;
      const part = Math.min((cells.length + 1) * 2 ** rest.length, n - 1);
      shift(part, src, via, rest);
      shift(n - part, src, dst, rest);
      shift(part, via, dst, rest);
    };
    const spare = s.tableau.map((col, c) => (!col.length && c !== to.idx ? c : -1)).filter(c => c >= 0);
    shift(ids.length, from.idx, to.idx, spare);
    return steps;
  }

  // Click / tap: the best legal spot for the card (and its run): home, onto another column,
  // an empty column, then a free cell.
  function clickTarget(from, ids) {
    const state = G.state;
    const tries = [];
    if (ids.length === 1) tries.push({ type: 'found', idx: card(ids[0]).suit });
    for (let c = 0; c < COLS; c++) if (state.tableau[c].length) tries.push({ type: 'tableau', idx: c });
    if (!(from.type === 'tableau' && from.pos === 0)) {
      const empty = state.tableau.findIndex(col => !col.length);
      if (empty >= 0) tries.push({ type: 'tableau', idx: empty });
    }
    if (from.type === 'tableau') {
      const cell = state.cells.indexOf(null);
      if (cell >= 0) tries.push({ type: 'cell', idx: cell });
    }
    const to = tries.find(t => canDrop(ids, from, t)) || null;
    if (!to && ids.length > capacity(false)) {
      G.toast(`Not enough space to move ${ids.length} cards together — free a cell or column first`);
    }
    return to;
  }

  // ---------- Safe auto-play ----------

  // A card is safe to send home when no winning line could still need it in the tableau:
  // both opposite-colour foundations have reached rank - 1, or rank - 2 while its same-colour
  // twin has reached rank - 3. (Clearview's game.js walks through why.)
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
    s.cells.forEach((id, i) => {
      if (id !== null) sources.push({ from: { type: 'cell', idx: i, pos: 0 }, id });
    });
    s.tableau.forEach((col, c) => {
      if (col.length) sources.push({ from: { type: 'tableau', idx: c, pos: col.length - 1 }, id: last(col) });
    });
    let best = null;
    for (const src of sources) {
      const c = card(src.id);
      if (canFound(src.id, s) && allow(src.id, s) && (!best || c.rank < card(best.ids[0]).rank)) {
        best = { from: src.from, ids: [src.id], to: { type: 'found', idx: c.suit } };
      }
    }
    return best;
  }

  // Auto-finish is offered once playing straight home from the cells and column ends wins.
  function canAutoFinish() {
    if (G.meta.won || foundCount() === 52) return false;
    const s = JSON.parse(JSON.stringify(G.state));
    let m;
    while ((m = nextFoundationMove(s))) put(s, m.to, take(s, m.from, 1));
    return foundCount(s) === 52;
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
    state.cells.forEach((id, i) => {
      if (id !== null) sources.push({ from: { type: 'cell', idx: i, pos: 0 }, ids: [id] });
    });
    state.tableau.forEach((col, c) => {
      for (let i = 0; i < col.length; i++) {
        if (isRun(col, i)) sources.push({ from: { type: 'tableau', idx: c, pos: i }, ids: col.slice(i) });
      }
    });

    const firstEmpty = state.tableau.findIndex(col => !col.length);
    const firstCell = state.cells.indexOf(null);

    // Would exposing `id` let it go home, or let another card or run move onto it?
    const opens = (id, movingFrom) =>
      canFound(id) || sources.some(o => !same(o.from, movingFrom) && fits(o.ids[0], id));

    for (const src of sources) {
      const { from, ids } = src;
      const base = ids[0];
      const single = ids.length === 1;
      const col = from.type === 'tableau' ? state.tableau[from.idx] : null;
      const below = col && from.pos > 0 ? col[from.pos - 1] : null;
      const belowHome = below !== null && canFound(below);

      if (single && canFound(base)) {
        out.push({ ...src, to: { type: 'found', idx: card(base).suit }, score: from.type === 'cell' ? 100 : 95 });
      }

      for (let c = 0; c < COLS; c++) {
        const target = state.tableau[c];
        if (!target.length || (from.type === 'tableau' && from.idx === c)) continue;
        if (!canDrop(ids, from, { type: 'tableau', idx: c })) continue;
        let score;
        if (from.type === 'cell') score = 70;
        else if (from.pos === 0) score = 60; // empties a column
        else if (belowHome) score = 65;
        else if (below !== null && fits(base, below)) continue; // shuffling a run between equal parents gains nothing
        else score = 45 + Math.min(ids.length, 5);
        out.push({ ...src, to: { type: 'tableau', idx: c }, score });
      }

      // Moving a whole column into an empty one gains nothing.
      const toEmpty = { type: 'tableau', idx: firstEmpty };
      if (firstEmpty >= 0 && !(from.type === 'tableau' && from.pos === 0) && canDrop(ids, from, toEmpty)) {
        let score = null;
        if (from.type === 'cell') score = 30 + (card(base).rank === 13 ? 10 : 0);
        else if (below === null || !fits(base, below)) score = belowHome ? 40 : 22 + (card(base).rank === 13 ? 10 : 0);
        if (score !== null) out.push({ ...src, to: toEmpty, score });
      }

      if (single && firstCell >= 0 && from.type === 'tableau' && below !== null && opens(below, from)) {
        out.push({ ...src, to: { type: 'cell', idx: firstCell }, score: belowHome ? 35 : 12 });
      }
    }

    return out.sort((a, b) => b.score - a.score);
  }

  function describe(h) {
    const what = nameOf(h.ids[0]) + (h.ids.length > 1 ? ` and the ${h.ids.length - 1} below it` : '');
    const pile = pileOf(h.to);
    let where;
    if (h.to.type === 'found') where = 'to its foundation';
    else if (h.to.type === 'cell') where = 'into a free cell';
    else where = pile.length ? `onto ${nameOf(last(pile))}` : 'into the empty column';
    return `Move ${what} ${where}`;
  }

  function targetEl(to) {
    const pile = pileOf(to);
    if (pile.length) return G.els[last(pile)];
    if (to.type === 'cell') return G.slots.cells[to.idx];
    return to.type === 'found' ? G.slots.found[to.idx] : G.slots.tab[to.idx];
  }

  // ---------- Layout & rendering ----------

  const colX = c => c * (G.L.cw + G.L.gap);

  function layout(availW, availH) {
    const gapR = 0.14;
    let cw = availW / (COLS + (COLS - 1) * gapR);
    cw = Math.min(cw, 120, availH / 1.4 / 3.9);
    cw = Math.floor(Math.max(cw, 34));
    const ch = Math.round(cw * 1.4);
    const gap = Math.round(cw * gapR);
    const top = 6;
    G.L = { cw, ch, gap, top, w: COLS * cw + (COLS - 1) * gap, h: availH, tabY: top + ch + Math.max(Math.round(gap * 1.6), 14) };

    const { slots } = G;
    slots.cells.forEach((el, i) => place(el, colX(i), top));
    slots.found.forEach((el, f) => place(el, colX(CELLS + f), top));
    slots.tab.forEach((el, c) => place(el, colX(c), G.L.tabY));
  }

  function positions() {
    const state = G.state;
    const out = {};
    const { ch, top } = G.L;

    state.cells.forEach((id, i) => {
      if (id !== null) out[id] = { x: colX(i), y: top, z: 100, down: false, key: 'c' + i };
    });

    state.foundations.forEach((f, fi) => {
      f.forEach((id, i) => {
        out[id] = { x: colX(CELLS + fi), y: top, z: 200 + i, down: false, key: 'f' + fi };
      });
    });

    // Long columns squeeze their fan to fit the table. Buried cards are shaded, except the next
    // card each foundation needs, so it's easy to spot what to dig out.
    const room = G.L.h - G.L.tabY - ch - 8;
    state.tableau.forEach((col, c) => {
      let off = ch * 0.27;
      if (col.length > 1) off = Math.max(ch * 0.1, Math.min(off, room / (col.length - 1)));
      let runStart = col.length - 1;
      while (runStart > 0 && fits(col[runStart], col[runStart - 1])) runStart--;
      col.forEach((id, i) => {
        out[id] = { x: colX(c), y: Math.round(G.L.tabY + i * off), z: 400 + i, down: false, key: 't' + c, locked: i < runStart && !canFound(id, state) };
      });
    });
    return out;
  }

  function dropZones() {
    const { L, P, state } = G;
    const zones = state.tableau.map((col, c) => ({
      to: { type: 'tableau', idx: c },
      x: colX(c), y: col.length ? P[last(col)].y : L.tabY, w: L.cw, h: L.ch * 1.5,
    }));
    for (let i = 0; i < CELLS; i++) zones.push({ to: { type: 'cell', idx: i }, x: colX(i), y: L.top, w: L.cw, h: L.ch });
    for (let f = 0; f < 4; f++) zones.push({ to: { type: 'found', idx: f }, x: colX(CELLS + f), y: L.top, w: L.cw, h: L.ch });
    return zones;
  }

  function dealOrder() {
    const order = [];
    for (let row = 0; row < 7; row++) {
      for (let c = 0; c < COLS; c++) if (row < G.state.tableau[c].length) order.push(G.state.tableau[c][row]);
    }
    return order;
  }

  // ---------- Building the DOM ----------

  function faceHTML(c) {
    const r = RANKS[c.rank - 1];
    const s = suitSVG(c.suit);
    let center;
    if (c.rank === 1) center = `<div class="center ace"><span>${s}</span></div>`;
    else if (c.rank > 10) center = `<div class="center court"><span class="cl">${r}</span><span class="cs">${s}</span></div>`;
    else center = `<div class="center pip"><span>${s}</span></div>`;
    const idx = pos => `<div class="idx ${pos}"><span class="r">${r}</span><span class="s">${s}</span></div>`;
    return `${idx('top')}${center}${idx('bot')}`;
  }

  function buildSlots() {
    const { slots } = G;
    slots.cells = Array.from({ length: CELLS }, () => G.makeSlot('cell', '<span class="cell-label">Free<br>cell</span>'));
    slots.found = SUITS.map((s, i) => G.makeSlot('found ' + s.color, `<span>${suitSVG(i)}</span>`));
    slots.tab = Array.from({ length: COLS }, () => G.makeSlot('tab'));
  }

  // ---------- HUD, rules & settings ----------

  function updateHud() {
    // While safe auto-play still has a card to send home, it's about to move on its own.
    const autoPending = G.settings.autoSafe && !!nextFoundationMove(G.state, isSafeHome);
    $('#btn-auto').classList.toggle('hidden', G.busy || autoPending || !canAutoFinish());
  }

  function validState(s) {
    const all = [...s.cells.filter(id => id !== null), ...s.foundations.flat(), ...s.tableau.flat()];
    return all.length === 52 && new Set(all).size === 52 &&
      s.cells.length === CELLS && s.tableau.length === COLS && s.foundations.length === 4;
  }

  function winOrder() {
    const order = [];
    for (let r = 12; r >= 0; r--) for (let f = 0; f < 4; f++) order.push(G.state.foundations[f][r]);
    return order;
  }

  const rulesHTML = () => `
    <h2>How to play</h2>
    <p class="sub">Every card is dealt face up, and nearly every deal can be won. It's all in the planning.</p>
    <h3>Goal</h3>
    <ul><li>Build all four foundations, one per suit, from Ace up to King.</li></ul>
    <h3>The table</h3>
    <ul>
      <li>All 52 cards are dealt face up into eight columns: four of seven cards and four of six.</li>
      <li>Stack cards in the columns in descending rank with alternating colours (red on black, black on red).</li>
      <li>Any card may fill an empty column.</li>
      <li>The four free cells each hold any one card while you work around it.</li>
      <li>Cards on the foundations stay there.</li>
    </ul>
    <h3>Moving runs</h3>
    <ul>
      <li>Officially only one card moves at a time, but an ordered run can be moved together when there's room to shuffle it across one card at a time.</li>
      <li>That's one more card than you have empty free cells, doubled for each empty column. Moving into an empty column, that column doesn't count.</li>
    </ul>
    <h3>Controls</h3>
    <ul>
      <li>Drag cards to move them, or tap a card to send it to the best legal spot.</li>
      <li><kbd>Z</kbd> undo · <kbd>H</kbd> hint · <kbd>N</kbd> new game · <kbd>R</kbd> rules · <kbd>S</kbd> settings</li>
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
    id: 'freecell',
    cards: CARDS,
    cardLabel: c => `${RANKS[c.rank - 1]} of ${SUITS[c.suit].name}`,
    faceHTML,
    buildSlots,
    layout,
    positions,
    freshState,
    validState,
    isWon: () => foundCount() === 52,
    winOrder,
    winText: 'Every suit is home, ace to king.',
    locate,
    grab,
    canDrop,
    apply: (s, from, ids, to) => put(s, to, take(s, from, ids.length)),
    moveSteps: SHOW_RUN_STEPS ? moveSteps : null,
    dropZones,
    targetEl,
    clickTarget,
    findHints,
    describe,
    dealOrder,
    dealFrom: () => ({ x: Math.round((G.L.w - G.L.cw) / 2), y: G.L.top, key: 'deal' }),
    nextAuto,
    updateHud,
    wire: () => $('#btn-auto').addEventListener('click', autoFinish),
    rulesHTML,
    settingsDefaults: { autoSafe: true },
    settingsHTML,
    onSetting,
  });

  G.start();
})();
