(() => {
  'use strict';

  const { last, same, place, shuffle } = Solitaire;

  // ---------- Card data ----------

  // 40 cards: the 1 to 9 of Fire, Water and Earth, four unranked face cards per suit, and one star.
  const SUITS = [
    { key: 'fire', name: 'Fire' },
    { key: 'water', name: 'Water' },
    { key: 'earth', name: 'Earth' },
  ];
  const COLS = 8;
  const CELLS = 3;
  const CARDS = [];
  for (let s = 0; s < 3; s++) {
    for (let r = 1; r <= 9; r++) CARDS.push({ id: CARDS.length, suit: s, rank: r, face: false, star: false, color: SUITS[s].key });
  }
  for (let s = 0; s < 3; s++) {
    for (let k = 0; k < 4; k++) CARDS.push({ id: CARDS.length, suit: s, rank: 0, face: true, star: false, color: SUITS[s].key });
  }
  const STAR = CARDS.length;
  CARDS.push({ id: STAR, suit: -1, rank: 0, face: false, star: true, color: 'star' });

  // How long a safe card glows before auto-play sends it home, from a column or a free cell.
  const CUE = { tableau: 450, cell: 320 };

  // Symbols drawn on a 100×100 box, like the shared engine's suits.
  const SYMBOLS = [
    // Fire: a flame with a tongue curling up its side
    '<path d="M52 2C56 22 80 34 80 62C80 82 67 96 50 96C33 96 20 83 20 64C20 50 27 40 35 31C35 43 40 51 47 55C43 38 44 18 52 2Z"/>',
    // Water: a drop
    '<path d="M50 3C62 26 83 45 83 66C83 84 69 97 50 97C31 97 17 84 17 66C17 45 38 26 50 3Z"/>',
    // Earth: twin peaks
    '<path d="M2 90L35 30L49 54L64 24L98 90Z"/>',
  ];
  const STAR_PATH = '<path d="M50 3L62 37L98 38L69 60L80 95L50 74L20 95L31 60L2 38L38 37Z"/>';
  // Each symbol is shifted so its optical centre, halfway between its bounding box's centre and
  // its centre of mass, sits in the middle of the box: the flame and drop carry their weight low
  // in their bulbs, the peaks in their wide base. Star last. Measured by rasterising the paths.
  const NUDGE = [[-1, -4], [0, -4], [0, -12], [0, -1]];
  const symSVG = s => {
    const [dx, dy] = NUDGE[s < 0 ? 3 : s];
    return `<svg class="suit-svg" viewBox="0 0 100 100" aria-hidden="true"><g transform="translate(${dx} ${dy})">${s < 0 ? STAR_PATH : SYMBOLS[s]}</g></svg>`;
  };

  const $ = sel => document.querySelector(sel);

  // The shared engine's table. G.state is
  //   { tableau[8], cells[3], sealed[3], found[3], star, moves }
  // where each cell is a pile (empty, one card, or a collapsed set of four faces), sealed[i] is
  // the suit collapsed into cell i or -1, and star is the star's pile.
  let G;

  // ---------- Rules helpers ----------

  const card = id => CARDS[id];
  const nameOf = id => {
    const c = card(id);
    if (c.star) return 'the star';
    return c.face ? `a ${SUITS[c.suit].name} face` : `the ${c.rank} of ${SUITS[c.suit].name}`;
  };
  const isFaceOf = (id, suit) => card(id).face && card(id).suit === suit;

  // Can `lower` be placed directly onto `upper` in a column? Numbers go down one rank onto a
  // different suit. Face cards and the star stack with nothing: they only go into an empty
  // column or a free cell.
  function fits(lower, upper) {
    const a = card(lower);
    const b = card(upper);
    if (a.star || b.star || a.face || b.face) return false;
    return b.rank === a.rank + 1 && b.suit !== a.suit;
  }

  function isRun(col, from) {
    for (let j = from + 1; j < col.length; j++) if (!fits(col[j], col[j - 1])) return false;
    return true;
  }

  const canFound = (id, s = G.state) => !card(id).face && !card(id).star && card(id).rank === s.found[card(id).suit].length + 1;
  const openCell = (s, i) => s.sealed[i] < 0 && !s.cells[i].length;

  // ---------- Collapsing face cards ----------

  // The face cards of a suit that are exposed: in a free cell, or the last card of a column.
  // A face with anything on it doesn't count.
  function looseFaces(suit, s = G.state) {
    const out = [];
    s.cells.forEach((p, i) => { if (s.sealed[i] < 0 && p.length && isFaceOf(p[0], suit)) out.push(p[0]); });
    s.tableau.forEach(col => { if (col.length && isFaceOf(last(col), suit)) out.push(last(col)); });
    return out;
  }

  // Where the suit would collapse to: a free cell already holding one of its faces, or else an empty one.
  function collapseCell(suit, s = G.state) {
    const holding = s.cells.findIndex((p, i) => s.sealed[i] < 0 && p.length && isFaceOf(p[0], suit));
    return holding >= 0 ? holding : s.cells.findIndex((p, i) => openCell(s, i));
  }

  const canCollapse = (suit, s = G.state) =>
    !s.sealed.includes(suit) && looseFaces(suit, s).length === 4 && collapseCell(suit, s) >= 0;

  function collapse(suit, s) {
    const ids = looseFaces(suit, s);
    const target = collapseCell(suit, s);
    const gone = new Set(ids);
    s.cells.forEach((p, i) => { if (s.sealed[i] < 0 && p.length && gone.has(p[0])) s.cells[i] = []; });
    s.tableau.forEach(col => { while (col.length && gone.has(last(col))) col.pop(); });
    s.cells[target] = ids;
    s.sealed[target] = suit;
  }

  function pressCollapse(suit) {
    if (G.busy || G.meta.won) return;
    if (!canCollapse(suit)) {
      const btn = G.slots.buttons[suit];
      btn.classList.remove('nope');
      void btn.offsetWidth;
      btn.classList.add('nope');
      if (!G.state.sealed.includes(suit)) {
        const n = looseFaces(suit).length;
        G.toast(n < 4
          ? `${n} of the 4 ${SUITS[suit].name} faces are in view`
          : `No room: free a cell, or put a ${SUITS[suit].name} face in one`);
      }
      return;
    }
    G.snapshot();
    collapse(suit, G.state);
    G.state.moves++;
    G.committed();
  }

  // ---------- State ----------

  function freshState() {
    const deck = shuffle([...Array(CARDS.length).keys()]);
    const tableau = Array.from({ length: COLS }, (_, c) => deck.slice(c * 5, c * 5 + 5));
    return {
      tableau,
      cells: Array.from({ length: CELLS }, () => []),
      sealed: Array(CELLS).fill(-1),
      found: [[], [], []],
      star: [],
      moves: 0,
    };
  }

  function locate(id) {
    const s = G.state;
    let i;
    for (let c = 0; c < CELLS; c++) if ((i = s.cells[c].indexOf(id)) >= 0) return { type: 'cell', idx: c, pos: i };
    for (let f = 0; f < 3; f++) if ((i = s.found[f].indexOf(id)) >= 0) return { type: 'found', idx: f, pos: i };
    if (s.star.includes(id)) return { type: 'star', pos: 0 };
    for (let c = 0; c < COLS; c++) if ((i = s.tableau[c].indexOf(id)) >= 0) return { type: 'tableau', idx: c, pos: i };
    return null;
  }

  function pileOf(ref, s = G.state) {
    switch (ref.type) {
      case 'cell': return s.cells[ref.idx];
      case 'found': return s.found[ref.idx];
      case 'star': return s.star;
      case 'tableau': return s.tableau[ref.idx];
    }
    return [];
  }

  // The cards that come along when picking up the card at `loc`, or null if it can't be picked up.
  // Any ordered run moves together, however long. Scored cards and collapsed faces stay put.
  function grab(loc) {
    if (loc.type === 'found' || loc.type === 'star') return null;
    if (loc.type === 'cell') return G.state.sealed[loc.idx] >= 0 ? null : [G.state.cells[loc.idx][0]];
    const col = G.state.tableau[loc.idx];
    return isRun(col, loc.pos) ? col.slice(loc.pos) : null;
  }

  function canDrop(ids, from, to, s = G.state) {
    if (same(from, to)) return false;
    const first = ids[0];
    switch (to.type) {
      case 'cell': return ids.length === 1 && openCell(s, to.idx);
      case 'found': return ids.length === 1 && card(first).suit === to.idx && canFound(first, s);
      case 'star': return ids.length === 1 && first === STAR;
      case 'tableau': {
        const col = s.tableau[to.idx];
        return !col.length || fits(first, last(col));
      }
    }
    return false;
  }

  function apply(s, from, ids, to) {
    const src = pileOf(from, s);
    src.splice(src.length - ids.length, ids.length);
    pileOf(to, s).push(...ids);
  }

  const isWon = (s = G.state) =>
    s.sealed.every(x => x >= 0) && s.found.every(f => f.length === 9) && s.star.length === 1;

  // ---------- Safe auto-play ----------

  // The cards that can be moved straight off the table: the end of each column and the free cells.
  function exposed(s) {
    const out = [];
    s.cells.forEach((p, i) => { if (s.sealed[i] < 0 && p.length) out.push({ from: { type: 'cell', idx: i, pos: 0 }, id: p[0] }); });
    s.tableau.forEach((col, c) => { if (col.length) out.push({ from: { type: 'tableau', idx: c, pos: col.length - 1 }, id: last(col) }); });
    return out;
  }

  // A number is safe to score once nothing could still need to go on it: the cards that could
  // (one rank lower, in the other two suits) are already scored. The star is always safe.
  function isSafeHome(id, s) {
    if (id === STAR) return true;
    const { rank, suit } = card(id);
    if (!canFound(id, s)) return false;
    return s.found.every((f, i) => i === suit || f.length >= rank - 1);
  }

  function nextHomeMove(s, allow = () => true) {
    let best = null;
    for (const { from, id } of exposed(s)) {
      if (id === STAR) return { from, ids: [id], to: { type: 'star', pos: 0 } };
      if (!canFound(id, s) || !allow(id, s)) continue;
      if (!best || card(id).rank < card(best.ids[0]).rank) best = { from, ids: [id], to: { type: 'found', idx: card(id).suit } };
    }
    return best;
  }

  function nextAuto() {
    const m = G.settings.autoSafe && nextHomeMove(G.state, isSafeHome);
    if (!m) return null;
    const step = () => apply(G.state, m.from, m.ids, m.to);
    return Object.assign(step, { ids: m.ids, to: m.to, cue: m.from.type === 'cell' ? CUE.cell : CUE.tableau });
  }

  // ---------- Click / tap ----------

  // The best legal spot for the card (and its run): scored, onto another column, an empty
  // column, then a free cell.
  function clickTarget(from, ids) {
    const s = G.state;
    const tries = [];
    if (ids.length === 1) {
      if (ids[0] === STAR) tries.push({ type: 'star', pos: 0 });
      else if (!card(ids[0]).face) tries.push({ type: 'found', idx: card(ids[0]).suit });
    }
    for (let c = 0; c < COLS; c++) if (s.tableau[c].length) tries.push({ type: 'tableau', idx: c });
    if (!(from.type === 'tableau' && from.pos === 0)) {
      const empty = s.tableau.findIndex(col => !col.length);
      if (empty >= 0) tries.push({ type: 'tableau', idx: empty });
    }
    if (from.type === 'tableau') {
      const cell = s.cells.findIndex((p, i) => openCell(s, i));
      if (cell >= 0) tries.push({ type: 'cell', idx: cell });
    }
    return tries.find(t => canDrop(ids, from, t)) || null;
  }

  // ---------- Hints ----------

  function findHints() {
    const s = G.state;
    const out = [];

    SUITS.forEach((suit, i) => {
      if (canCollapse(i)) out.push({ el: G.slots.buttons[i], suit: i, score: 98 });
    });

    const sources = [];
    s.cells.forEach((p, i) => {
      if (s.sealed[i] < 0 && p.length) sources.push({ from: { type: 'cell', idx: i, pos: 0 }, ids: [p[0]] });
    });
    s.tableau.forEach((col, c) => {
      for (let i = 0; i < col.length; i++) {
        if (isRun(col, i)) sources.push({ from: { type: 'tableau', idx: c, pos: i }, ids: col.slice(i) });
      }
    });

    const firstEmpty = s.tableau.findIndex(col => !col.length);
    const firstCell = s.cells.findIndex((p, i) => openCell(s, i));

    // Would uncovering `id` let it be scored, or let another card or run move onto it?
    const opens = (id, movingFrom) =>
      canFound(id) || id === STAR || sources.some(o => !same(o.from, movingFrom) && fits(o.ids[0], id));

    for (const src of sources) {
      const { from, ids } = src;
      const base = ids[0];
      const single = ids.length === 1;
      const col = from.type === 'tableau' ? s.tableau[from.idx] : null;
      const below = col && from.pos > 0 ? col[from.pos - 1] : null;
      const belowHome = below !== null && canFound(below);
      const alreadyRun = below !== null && fits(base, below);

      if (single && base === STAR) out.push({ ...src, to: { type: 'star', pos: 0 }, score: 100 });
      if (single && canFound(base)) out.push({ ...src, to: { type: 'found', idx: card(base).suit }, score: 100 });

      for (let c = 0; c < COLS; c++) {
        const target = s.tableau[c];
        if (!target.length || (from.type === 'tableau' && from.idx === c)) continue;
        if (!fits(base, last(target))) continue;
        let score;
        if (from.type === 'cell') score = 70;
        else if (from.pos === 0) score = 60;
        else if (belowHome) score = 65;
        else if (alreadyRun) continue; // shuffling a run between equal parents gains nothing
        else score = 45;
        out.push({ ...src, to: { type: 'tableau', idx: c }, score });
      }

      if (firstEmpty >= 0 && !(from.type === 'tableau' && from.pos === 0) && !alreadyRun) {
        const nine = card(base).rank === 9;
        const score = from.type === 'cell' ? 24 + (nine ? 8 : 0) : (belowHome ? 40 : 22 + (nine ? 8 : 0));
        out.push({ ...src, to: { type: 'tableau', idx: firstEmpty }, score });
      }

      if (single && firstCell >= 0 && from.type === 'tableau' && below !== null && opens(below, from)) {
        out.push({ ...src, to: { type: 'cell', idx: firstCell }, score: belowHome ? 35 : 12 });
      }
    }

    return out.sort((a, b) => b.score - a.score);
  }

  function describe(h) {
    if (h.suit !== undefined) return `Collapse the four ${SUITS[h.suit].name} faces`;
    const what = nameOf(h.ids[0]) + (h.ids.length > 1 ? ` and the ${h.ids.length - 1} below it` : '');
    const pile = pileOf(h.to);
    let where;
    if (h.to.type === 'found') where = 'to its scoring pile';
    else if (h.to.type === 'star') where = 'to the star pile';
    else if (h.to.type === 'cell') where = 'into a free cell';
    else where = pile.length ? `onto ${nameOf(last(pile))}` : 'into the empty column';
    const text = `Move ${what} ${where}`;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function targetEl(to) {
    const pile = pileOf(to);
    if (pile.length) return G.els[last(pile)];
    switch (to.type) {
      case 'cell': return G.slots.cells[to.idx];
      case 'found': return G.slots.found[to.idx];
      case 'star': return G.slots.star;
    }
    return G.slots.tab[to.idx];
  }

  // ---------- Layout & rendering ----------

  // Top row: three free cells, the collapse buttons, the star pile, then the three scoring piles.
  // With two rows the cells and buttons sit above the star and scoring piles.
  const colX = c => c * (G.L.cw + G.L.gap);
  const BTN_COL = 3;
  const STAR_COL = 4;
  const FOUND_COL = 5;
  const topPos = k => ({ x: colX(k % G.L.per), y: G.L.top + Math.floor(k / G.L.per) * (G.L.ch + G.L.gap) });

  // Where column c starts, and how far down its cards may fan. With two rows the first four
  // columns sit on top and the other four beneath them.
  function colPos(c) {
    const { per, ch, gap, h, rowY } = G.L;
    const row = Math.floor(c / per);
    const end = row + 1 < rowY.length ? rowY[row + 1] - Math.max(gap, 10) : h - 8;
    return { x: colX(c % per), y: rowY[row], room: end - rowY[row] - ch };
  }

  function layout(availW, availH) {
    const gapR = 0.14;
    // The card width for `per` columns across, when the board is `tall` card heights high.
    const fit = (per, tall) =>
      Math.floor(Math.max(34, Math.min(availW / (per + (per - 1) * gapR), 116, availH / 1.4 / tall)));
    let per = COLS;
    let cw = fit(COLS, 4.1);
    // Two rows only when they give bigger cards, i.e. on tall, narrow screens.
    if (G.settings.twoRows && fit(COLS / 2, 7.6) > cw) {
      per = COLS / 2;
      cw = fit(per, 7.6);
    }
    const ch = Math.round(cw * 1.4);
    const gap = Math.round(cw * gapR);
    const top = 6;
    const rows = COLS / per;
    const tabY = top + rows * ch + (rows - 1) * gap + Math.max(Math.round(gap * 1.6), 14);
    const rowY = Array.from({ length: rows }, (_, r) => Math.round(tabY + r * (availH - tabY) / rows));
    G.L = { cw, ch, gap, top, per, rowY, tabY, w: per * cw + (per - 1) * gap, h: availH };

    const { slots } = G;
    const at = (el, k) => place(el, topPos(k).x, topPos(k).y);
    slots.cells.forEach((el, i) => at(el, i));
    at(slots.btns, BTN_COL);
    at(slots.star, STAR_COL);
    slots.found.forEach((el, f) => at(el, FOUND_COL + f));
    slots.tab.forEach((el, c) => place(el, colPos(c).x, colPos(c).y));
  }

  function positions() {
    const s = G.state;
    const out = {};
    const { ch } = G.L;

    s.cells.forEach((p, i) => {
      // A collapsed suit is a squared-up, face-down pile.
      const down = s.sealed[i] >= 0;
      const { x, y } = topPos(i);
      p.forEach((id, k) => {
        out[id] = { x: x - (down ? k : 0), y: y - (down ? k : 0), z: 100 + k, down, key: 'c' + i };
      });
    });
    s.found.forEach((f, fi) => {
      f.forEach((id, k) => { out[id] = { ...topPos(FOUND_COL + fi), z: 200 + k, down: false, key: 'f' + fi }; });
    });
    s.star.forEach(id => { out[id] = { ...topPos(STAR_COL), z: 200, down: false, key: 'star' }; });

    // Long columns squeeze their fan to fit the table. Cards buried under the movable run are shaded.
    s.tableau.forEach((col, c) => {
      const { x, y, room } = colPos(c);
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
    G.els.forEach(el => el.classList.remove('sealed-top'));
    s.cells.forEach((p, i) => { if (s.sealed[i] >= 0) G.els[last(p)].classList.add('sealed-top'); });
    G.slots.buttons.forEach((btn, suit) => {
      const done = s.sealed.includes(suit);
      btn.classList.toggle('done', done);
      btn.classList.toggle('ready', !done && canCollapse(suit));
      btn.title = done
        ? `${SUITS[suit].name} faces collapsed`
        : `Collapse the ${SUITS[suit].name} faces (${suit + 1})`;
    });
  }

  function dropZones() {
    const { L, P, state } = G;
    const zones = state.tableau.map((col, c) => ({
      to: { type: 'tableau', idx: c },
      x: colPos(c).x, y: col.length ? P[last(col)].y : colPos(c).y, w: L.cw, h: L.ch * 1.5,
    }));
    for (let i = 0; i < CELLS; i++) zones.push({ to: { type: 'cell', idx: i }, ...topPos(i), w: L.cw, h: L.ch });
    zones.push({ to: { type: 'star', pos: 0 }, ...topPos(STAR_COL), w: L.cw, h: L.ch });
    for (let f = 0; f < 3; f++) zones.push({ to: { type: 'found', idx: f }, ...topPos(FOUND_COL + f), w: L.cw, h: L.ch });
    return zones;
  }

  function dealOrder() {
    const order = [];
    for (let row = 0; row < 5; row++) {
      for (let c = 0; c < COLS; c++) order.push(G.state.tableau[c][row]);
    }
    return order;
  }

  // ---------- Building the DOM ----------

  function faceHTML(c) {
    if (c.star) {
      const idx = pos => `<div class="idx ${pos} suit-only"><span class="s">${symSVG(-1)}</span></div>`;
      return `${idx('top')}<div class="center star-burst"><span>${symSVG(-1)}</span></div>${idx('bot')}`;
    }
    const s = symSVG(c.suit);
    if (c.face) {
      const idx = pos => `<div class="idx ${pos} suit-only"><span class="s">${s}</span></div>`;
      return `${idx('top')}<div class="center crest"><span>${s}</span><b>${SUITS[c.suit].name}</b></div>${idx('bot')}`;
    }
    const idx = pos => `<div class="idx ${pos}"><span class="r">${c.rank}</span><span class="s">${s}</span></div>`;
    return `${idx('top')}<div class="center pip"><span>${s}</span></div>${idx('bot')}`;
  }

  // Face cards carry their suit on the back, shown once they're collapsed into a pile.
  const backHTML = c => c.face ? `<span class="seal ${c.color}">${symSVG(c.suit)}</span>` : '';

  function buildSlots() {
    const { slots } = G;
    slots.cells = Array.from({ length: CELLS }, () => G.makeSlot('cell', '<span class="cell-label">Free<br>cell</span>'));
    slots.btns = G.makeSlot('collapse', SUITS.map((s, i) =>
      `<button class="collapse-btn ${s.key}" data-suit="${i}" aria-label="Collapse the ${s.name} faces">${symSVG(i)}</button>`).join(''));
    slots.buttons = [...slots.btns.querySelectorAll('.collapse-btn')];
    slots.star = G.makeSlot('star-pile', `<span>${symSVG(-1)}</span>`);
    slots.found = SUITS.map((s, i) => G.makeSlot('found ' + s.key, `<span>${symSVG(i)}</span>`));
    slots.tab = Array.from({ length: COLS }, () => G.makeSlot('tab'));
  }

  function wire() {
    G.slots.buttons.forEach((btn, suit) => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', () => pressCollapse(suit));
    });
  }

  // ---------- Rules & settings ----------

  function validState(s) {
    const all = [...s.tableau.flat(), ...s.cells.flat(), ...s.found.flat(), ...s.star];
    return s.tableau.length === COLS && s.cells.length === CELLS && s.sealed.length === CELLS && s.found.length === 3 &&
      all.length === CARDS.length && new Set(all).size === CARDS.length;
  }

  const rulesHTML = () => `
    <h2>How to play</h2>
    <p class="sub">A 40-card deck of three elements and a star, all dealt face up.</p>
    <h3>Goal</h3>
    <ul>
      <li>Score the 1 to 9 of Fire, Water and Earth on their piles, send the star to its own pile, and collapse each suit's four face cards.</li>
    </ul>
    <h3>The deck</h3>
    <ul>
      <li>Each suit has the numbers 1 to 9 and four face cards, which have no rank. There's also a single star.</li>
      <li>All 40 cards are dealt face up into eight columns of five.</li>
    </ul>
    <h3>Moving cards</h3>
    <ul>
      <li>Number cards stack in descending rank on a card of a different suit, so a Fire or Earth 4 can go on a Water 5.</li>
      <li>Face cards don't stack on anything, and nothing stacks on them. They can only go into an empty column or a free cell.</li>
      <li>Any ordered run can be moved together, whatever its length, and any card or run may go into an empty column.</li>
      <li>The three free cells each hold any one card.</li>
      <li>Scoring piles build up from 1 to 9 in a single suit. Scored cards stay there.</li>
    </ul>
    <h3>Collapsing faces</h3>
    <ul>
      <li>When all four face cards of a suit are exposed (each one in a free cell or at the very end of a column), that suit's button glows.</li>
      <li>Press it to turn them into a face-down pile in a free cell, either one that already holds one of those faces or an empty one. That cell stays taken for the rest of the game.</li>
    </ul>
    <h3>Controls</h3>
    <ul>
      <li>Drag cards to move them, or tap a card to send it to the best legal spot.</li>
      <li><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> collapse Fire, Water, Earth · <kbd>Z</kbd> undo · <kbd>H</kbd> hint · <kbd>N</kbd> new game · <kbd>R</kbd> rules · <kbd>S</kbd> settings</li>
    </ul>`;

  const settingsHTML = () => `
    <label class="toggle">
      <input type="checkbox" data-setting="autoSafe"${G.settings.autoSafe ? ' checked' : ''}>
      <span class="switch" aria-hidden="true"></span>
      <span><b>Auto-play safe cards</b><small>Scores a number automatically once nothing could still need to go on it, and sends the star home as soon as it's free. This never turns a winnable game into a lost one.</small></span>
    </label>
    <label class="toggle">
      <input type="checkbox" data-setting="twoRows"${G.settings.twoRows ? ' checked' : ''}>
      <span class="switch" aria-hidden="true"></span>
      <span><b>Two-row layout</b><small>On tall, narrow screens like phones, splits the eight columns into two rows of four, with the top piles stacked the same way, so the cards can be bigger. Wide screens keep a single row.</small></span>
    </label>`;

  function onSetting(key) {
    if (key === 'twoRows') {
      G.layout();
      if (!G.meta.won) G.render();
      return;
    }
    if (key !== 'autoSafe') return;
    if (G.settings.autoSafe) G.autoPlay();
    else G.stopAutoPlay();
  }

  function onKey(key) {
    if (key === '1' || key === '2' || key === '3') pressCollapse(+key - 1);
  }

  // ---------- Start ----------

  G = Solitaire.createGame({
    id: 'elements',
    cards: CARDS,
    cardLabel: c => c.star ? 'Star' : c.face ? `${SUITS[c.suit].name} face card` : `${c.rank} of ${SUITS[c.suit].name}`,
    faceHTML,
    backHTML,
    buildSlots,
    layout,
    positions,
    afterRender,
    freshState,
    validState,
    isWon: () => isWon(),
    winOrder: () => [...G.state.tableau.flat(), ...G.state.cells.flat(), ...G.state.star, ...G.state.found.flat()].reverse(),
    winText: 'Every element scored, every face collapsed, and the star in its place.',
    locate,
    grab,
    canDrop: (ids, from, to) => canDrop(ids, from, to),
    apply,
    dropZones,
    targetEl,
    clickTarget,
    findHints,
    describe,
    dealOrder,
    dealFrom: () => ({ x: Math.round((G.L.w - G.L.cw) / 2), y: G.L.top, key: 'deal' }),
    nextAuto,
    wire,
    onKey,
    rulesHTML,
    settingsDefaults: { autoSafe: true, twoRows: false },
    settingsHTML,
    onSetting,
  });

  G.start();
})();
