(() => {
  'use strict';

  const { SUITS, TEXT_STYLE, suitSVG, last, same, place, shuffle } = Solitaire;

  // ---------- Card data ----------

  // 36 cards: the 6 to 10 of each suit, plus four unranked face cards per suit.
  const COLS = 9;
  const CARDS = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 6; r <= 10; r++) CARDS.push({ id: CARDS.length, suit: s, rank: r, face: false, color: SUITS[s].color });
  }
  for (let s = 0; s < 4; s++) {
    for (let k = 0; k < 4; k++) CARDS.push({ id: CARDS.length, suit: s, rank: 0, face: true, color: SUITS[s].color });
  }

  const SEAL_WAIT = 380; // ms for a fourth face card to land before its column seals

  let G; // the shared engine's table: G.state is { tableau[9], free, sealed[9], moves }

  // ---------- Rules helpers ----------

  const card = id => CARDS[id];
  const sym = id => SUITS[card(id).suit].sym + TEXT_STYLE;
  const nameOf = id => card(id).face ? `${sym(id)} face` : card(id).rank + sym(id);

  // Can `lower` be placed directly onto `upper`? Numbers go down in rank with alternating
  // colours; face cards go on face cards of their own suit.
  function fits(lower, upper) {
    const a = card(lower);
    const b = card(upper);
    if (a.face || b.face) return a.face && b.face && a.suit === b.suit;
    return b.rank === a.rank + 1 && b.color !== a.color;
  }

  function isRun(col, from) {
    for (let j = from + 1; j < col.length; j++) if (!fits(col[j], col[j - 1])) return false;
    return true;
  }

  // A column holding nothing but all four face cards of one suit is ready to seal.
  const sealable = col => col.length === 4 && card(col[0]).face && isRun(col, 0);

  // A finished run: 10 down to 6 with alternating colours, alone in its column.
  const fullRun = col => col.length === 5 && card(col[0]).rank === 10 && isRun(col, 0);

  const sealedCount = (s = G.state) => s.sealed.filter(Boolean).length;
  const runCount = (s = G.state) => s.tableau.filter((col, c) => !s.sealed[c] && fullRun(col)).length;

  function freshState() {
    const deck = shuffle([...Array(CARDS.length).keys()]);
    const tableau = Array.from({ length: COLS }, (_, c) => deck.slice(c * 4, c * 4 + 4));
    return { tableau, free: null, sealed: Array(COLS).fill(false), moves: 0 };
  }

  function locate(id) {
    if (G.state.free === id) return { type: 'free', pos: 0 };
    for (let c = 0; c < COLS; c++) {
      const i = G.state.tableau[c].indexOf(id);
      if (i >= 0) return { type: 'tableau', idx: c, pos: i };
    }
    return null;
  }

  const pileOf = (ref, s = G.state) =>
    ref.type === 'free' ? (s.free === null ? [] : [s.free]) : s.tableau[ref.idx];

  // The cards that come along when picking up the card at `loc`, or null if it can't be picked up.
  function grab(loc) {
    if (loc.type === 'free') return [G.state.free];
    if (G.state.sealed[loc.idx]) return null;
    const col = G.state.tableau[loc.idx];
    return isRun(col, loc.pos) ? col.slice(loc.pos) : null;
  }

  function canDrop(ids, from, to) {
    if (same(from, to)) return false;
    if (to.type === 'free') return ids.length === 1 && G.state.free === null;
    if (G.state.sealed[to.idx]) return false;
    const col = G.state.tableau[to.idx];
    return !col.length || fits(ids[0], last(col));
  }

  function apply(s, from, ids, to) {
    if (from.type === 'free') s.free = null;
    else s.tableau[from.idx].splice(-ids.length, ids.length);
    if (to.type === 'free') s.free = ids[0];
    else s.tableau[to.idx].push(...ids);
  }

  // Sealing happens on its own a moment after the fourth face card lands, riding on that
  // move's undo snapshot.
  function nextAuto() {
    const s = G.state;
    const c = s.tableau.findIndex((col, i) => !s.sealed[i] && sealable(col));
    return c < 0 ? null : () => { s.sealed[c] = true; };
  }

  // Click / tap: the best legal spot for the card (and its run).
  function clickTarget(from, ids) {
    const s = G.state;
    const tries = [];
    const empty = s.tableau.findIndex(col => !col.length);
    const canEmpty = empty >= 0 && !(from.type === 'tableau' && from.pos === 0);
    const fullSet = ids.length === 4 && card(ids[0]).face;
    if (fullSet && canEmpty) tries.push({ type: 'tableau', idx: empty });
    for (let c = 0; c < COLS; c++) if (s.tableau[c].length) tries.push({ type: 'tableau', idx: c });
    if (canEmpty) tries.push({ type: 'tableau', idx: empty });
    if (from.type === 'tableau') tries.push({ type: 'free' });
    return tries.find(t => canDrop(ids, from, t)) || null;
  }

  // ---------- Hints ----------

  function findHints() {
    const s = G.state;
    const out = [];
    const sources = [];
    if (s.free !== null) sources.push({ from: { type: 'free' }, ids: [s.free] });
    s.tableau.forEach((col, c) => {
      if (s.sealed[c]) return;
      for (let i = 0; i < col.length; i++) {
        if (isRun(col, i)) sources.push({ from: { type: 'tableau', idx: c, pos: i }, ids: col.slice(i) });
      }
    });

    const firstEmpty = s.tableau.findIndex(col => !col.length);

    // Would exposing `id` let another card or run move onto it?
    const opens = (id, movingFrom) => sources.some(o => !same(o.from, movingFrom) && fits(o.ids[0], id));

    for (const src of sources) {
      const { from, ids } = src;
      const base = ids[0];
      const face = card(base).face;
      const col = from.type === 'tableau' ? s.tableau[from.idx] : null;
      const below = col && from.pos > 0 ? col[from.pos - 1] : null;
      const alreadyRun = below !== null && fits(base, below);
      if (alreadyRun) continue; // moving part of a run onto an equal parent gains nothing

      for (let c = 0; c < COLS; c++) {
        const target = s.tableau[c];
        if (!target.length || s.sealed[c] || (from.type === 'tableau' && from.idx === c)) continue;
        if (!fits(base, last(target))) continue;
        const seals = face && target.length + ids.length === 4 && sealable([...target, ...ids]);
        let score;
        if (seals) score = 95;
        else if (from.type === 'free') score = 70;
        else if (from.pos === 0) score = 55;
        else score = 45 + (face ? 5 : 0);
        out.push({ ...src, to: { type: 'tableau', idx: c }, seals, score });
      }

      if (firstEmpty >= 0 && !(from.type === 'tableau' && from.pos === 0)) {
        const seals = sealable(ids);
        const ten = card(base).rank === 10;
        let score;
        if (seals) score = 90;
        else if (from.type === 'free') score = ten ? 30 : 24;
        else score = 22 + (ten ? 10 : 0);
        out.push({ ...src, to: { type: 'tableau', idx: firstEmpty }, seals, score });
      }

      if (ids.length === 1 && s.free === null && from.type === 'tableau' && below !== null && opens(below, from)) {
        out.push({ ...src, to: { type: 'free' }, score: 12 });
      }
    }

    return out.sort((a, b) => b.score - a.score);
  }

  function describe(h) {
    const what = nameOf(h.ids[0]) + (h.ids.length > 1 ? ` and the ${h.ids.length - 1} below it` : '');
    const pile = pileOf(h.to);
    let where;
    if (h.to.type === 'free') where = 'into the free cell';
    else where = pile.length ? `onto ${nameOf(last(pile))}` : 'into the empty column';
    const seal = h.seals ? ` to seal the ${SUITS[card(h.ids[0]).suit].name.toLowerCase()}` : '';
    return `Move ${what} ${where}${seal}`;
  }

  function targetEl(to) {
    const pile = pileOf(to);
    if (pile.length) return G.els[last(pile)];
    return to.type === 'free' ? G.slots.free : G.slots.tab[to.idx];
  }

  // ---------- Layout & rendering ----------

  // Where column c starts, and how far down its cards may fan. With two rows the first five
  // columns sit on top and the other four are centred beneath them.
  function colPos(c) {
    const { per, cw, gap, ch, h, rowY } = G.L;
    const row = Math.floor(c / per);
    const inRow = Math.min(per, COLS - row * per);
    const x = Math.round((c % per + (per - inRow) / 2) * (cw + gap));
    const end = row + 1 < rowY.length ? rowY[row + 1] - Math.max(gap, 10) : h - 8;
    return { x, y: rowY[row], room: end - rowY[row] - ch };
  }

  const freeX = () => Math.floor(G.L.per / 2) * (G.L.cw + G.L.gap);

  function layout(availW, availH) {
    const gapR = 0.14;
    // The card width for `per` columns across, when the board is `tall` card heights high.
    const fit = (per, tall) =>
      Math.floor(Math.max(30, Math.min(availW / (per + (per - 1) * gapR), 116, availH / 1.4 / tall)));
    let per = COLS;
    let cw = fit(COLS, 3.6);
    // Two rows only when they give bigger cards, i.e. on tall, narrow screens. Each row
    // keeps room to fan about six cards.
    if (G.settings.twoRows && fit(5, 6) > cw) {
      per = 5;
      cw = fit(5, 6);
    }
    const ch = Math.round(cw * 1.4);
    const gap = Math.round(cw * gapR);
    const top = 6;
    const tabY = top + ch + Math.max(Math.round(gap * 1.6), 14);
    const rows = Math.ceil(COLS / per);
    const rowY = Array.from({ length: rows }, (_, r) => Math.round(tabY + r * (availH - tabY) / rows));
    G.L = { cw, ch, gap, top, per, rowY, w: per * cw + (per - 1) * gap, h: availH };

    const { slots } = G;
    const sideW = freeX() - gap;
    place(slots.free, freeX(), top);
    place(slots.seals, 0, top);
    place(slots.runs, freeX() + cw + gap, top);
    slots.seals.style.width = slots.runs.style.width = sideW + 'px';
    slots.tab.forEach((el, c) => place(el, colPos(c).x, colPos(c).y));
  }

  function positions() {
    const s = G.state;
    const out = {};
    const { ch, top } = G.L;

    if (s.free !== null) out[s.free] = { x: freeX(), y: top, z: 60, down: false, key: 'free' };

    s.tableau.forEach((col, c) => {
      const { x, y, room } = colPos(c);
      if (s.sealed[c]) {
        // A sealed column is a squared-up, face-down pile.
        col.forEach((id, i) => {
          out[id] = { x: x - i, y: y - i, z: 400 + i, down: true, key: 't' + c };
        });
        return;
      }
      let off = ch * 0.27;
      if (col.length > 1) off = Math.max(ch * 0.1, Math.min(off, room / (col.length - 1)));
      let runStart = col.length - 1;
      while (runStart > 0 && fits(col[runStart], col[runStart - 1])) runStart--;
      col.forEach((id, i) => {
        out[id] = { x, y: Math.round(y + i * off), z: 400 + i, down: false, key: 't' + c, locked: i < runStart };
      });
    });
    return out;
  }

  function afterRender() {
    const s = G.state;
    const { els, slots } = G;
    const sealedSuits = new Set();
    els.forEach(el => el.classList.remove('sealed-top'));
    s.tableau.forEach((col, c) => {
      slots.tab[c].classList.toggle('sealed', s.sealed[c]);
      if (!s.sealed[c]) return;
      sealedSuits.add(card(col[0]).suit);
      els[last(col)].classList.add('sealed-top');
    });
    slots.seals.querySelectorAll('i').forEach((el, suit) => el.classList.toggle('on', sealedSuits.has(suit)));
    const runs = runCount();
    slots.runs.querySelectorAll('i').forEach((el, k) => el.classList.toggle('on', k < runs));
  }

  function dropZones() {
    const { L, P, state } = G;
    const zones = state.tableau.map((col, c) => ({
      to: { type: 'tableau', idx: c },
      x: colPos(c).x, y: col.length ? P[last(col)].y : colPos(c).y, w: L.cw, h: L.ch * 1.5,
    }));
    zones.push({ to: { type: 'free' }, x: freeX(), y: L.top, w: L.cw, h: L.ch });
    return zones;
  }

  function dealOrder() {
    const order = [];
    for (let row = 0; row < 4; row++) {
      for (let c = 0; c < COLS; c++) order.push(G.state.tableau[c][row]);
    }
    return order;
  }

  // ---------- Building the DOM ----------

  function faceHTML(c) {
    const s = suitSVG(c.suit);
    if (c.face) {
      const idx = pos => `<div class="idx ${pos} suit-only"><span class="s">${s}</span></div>`;
      return `${idx('top')}<div class="center crest"><span>${s}</span></div>${idx('bot')}`;
    }
    const idx = pos => `<div class="idx ${pos}"><span class="r">${c.rank}</span><span class="s">${s}</span></div>`;
    return `${idx('top')}<div class="center pip"><span>${s}</span></div>${idx('bot')}`;
  }

  // Face cards carry their suit on the back, shown once they're sealed into a pile.
  const backHTML = c => c.face ? `<span class="seal">${suitSVG(c.suit)}</span>` : '';

  function buildSlots() {
    const { slots } = G;
    slots.seals = G.makeSlot('goal', `<span class="goal-label">Sealed</span><span class="goal-items">${SUITS.map((s, i) => `<i class="${s.color}">${suitSVG(i)}</i>`).join('')}</span>`);
    slots.free = G.makeSlot('free', '<span class="free-label">Free<br>cell</span>');
    slots.runs = G.makeSlot('goal', `<span class="goal-label">10 to 6 runs</span><span class="goal-items">${`<i class="run">${'<b></b>'.repeat(5)}</i>`.repeat(4)}</span>`);
    slots.tab = Array.from({ length: COLS }, () => G.makeSlot('tab'));
  }

  // ---------- Rules ----------

  function validState(s) {
    const all = s.tableau.flat();
    if (s.free !== null) all.push(s.free);
    return s.tableau.length === COLS && s.sealed.length === COLS &&
      all.length === CARDS.length && new Set(all).size === CARDS.length;
  }

  const rulesHTML = () => `
    <h2>How to play</h2>
    <p class="sub">A short 36-card deck, every card face up. Sort the numbers and gather the faces.</p>
    <h3>Goal</h3>
    <ul>
      <li>Seal all four suits of face cards, and build four runs from 10 down to 6, each in a column of its own.</li>
    </ul>
    <h3>The deck</h3>
    <ul>
      <li>The 6 to 10 of each suit, plus four face cards per suit. Face cards have no rank, only a suit.</li>
      <li>All 36 cards are dealt face up into nine columns of four.</li>
    </ul>
    <h3>Moving cards</h3>
    <ul>
      <li>Number cards stack in descending rank with alternating colours (red on black, black on red).</li>
      <li>Face cards stack on other face cards of the same suit.</li>
      <li>Any ordered run can be moved together, and any card or run may be placed into an empty column.</li>
      <li>The free cell holds any one card.</li>
    </ul>
    <h3>Sealing</h3>
    <ul>
      <li>When the four face cards of a suit are stacked in an otherwise empty column, they turn over into a sealed pile. A sealed pile can't be moved or built on.</li>
    </ul>
    <h3>Controls</h3>
    <ul>
      <li>Drag cards to move them, or tap a card to send it to the best legal spot.</li>
      <li><kbd>Z</kbd> undo · <kbd>H</kbd> hint · <kbd>N</kbd> new game · <kbd>R</kbd> rules · <kbd>S</kbd> settings</li>
    </ul>`;

  const settingsHTML = () => `
    <label class="toggle">
      <input type="checkbox" data-setting="twoRows"${G.settings.twoRows ? ' checked' : ''}>
      <span class="switch" aria-hidden="true"></span>
      <span><b>Two-row layout</b><small>On tall, narrow screens like phones, splits the nine columns into rows of five and four so the cards can be bigger. Wide screens keep a single row.</small></span>
    </label>`;

  function onSetting(key) {
    if (key !== 'twoRows') return;
    G.layout();
    if (!G.meta.won) G.render();
  }

  // ---------- Start ----------

  G = Solitaire.createGame({
    id: 'quartet',
    cards: CARDS,
    cardLabel: c => c.face ? `${SUITS[c.suit].name} face card` : `${c.rank} of ${SUITS[c.suit].name}`,
    faceHTML,
    backHTML,
    buildSlots,
    layout,
    positions,
    afterRender,
    freshState,
    validState,
    isWon: () => sealedCount() === 4 && runCount() === 4,
    winOrder: () => G.state.tableau.flat().reverse(),
    winText: 'Every suit sealed, every run in order.',
    locate,
    grab,
    canDrop,
    apply,
    dropZones,
    targetEl,
    clickTarget,
    findHints,
    describe,
    dealOrder,
    dealFrom: () => ({ x: freeX(), y: G.L.top, key: 'deal' }),
    nextAuto,
    autoStep: SEAL_WAIT,
    rulesHTML,
    settingsDefaults: { twoRows: false },
    settingsHTML,
    onSetting,
  });

  G.start();
})();
