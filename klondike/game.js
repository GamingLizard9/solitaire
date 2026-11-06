(() => {
  'use strict';

  const { SUITS, TEXT_STYLE, suitSVG, last, same, place, shuffle } = Solitaire;

  // ---------- Card data ----------

  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const CARDS = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 1; r <= 13; r++) CARDS.push({ id: CARDS.length, suit: s, rank: r, color: SUITS[s].color });
  }

  const DRAWS = [1, 2, 3];
  const WORDS = ['', 'one', 'two', 'three'];
  const AUTO_BEAT = 400;        // ms pause after a card turns over, before it's auto-played
  const AUTO_AFTER_FLIP = 500 + AUTO_BEAT; // the flip itself takes 0.5s

  const $ = sel => document.querySelector(sel);

  // The shared engine's table. G.state is { stock, waste, foundations[4], tableau[7], hidden[7],
  // draw, moves }: hidden[c] counts the face-down cards at the bottom of column c.
  let G;

  // ---------- Rules helpers ----------

  const card = id => CARDS[id];
  const nameOf = id => RANKS[card(id).rank - 1] + SUITS[card(id).suit].sym + TEXT_STYLE;
  const foundCount = (s = G.state) => s.foundations.reduce((n, f) => n + f.length, 0);
  const hiddenCount = (s = G.state) => s.hidden.reduce((n, h) => n + h, 0);

  // Can `lower` be placed directly onto `upper` in the tableau?
  const fits = (lower, upper) =>
    card(upper).rank === card(lower).rank + 1 && card(upper).color !== card(lower).color;

  const canFound = (id, s = G.state) => card(id).rank === s.foundations[card(id).suit].length + 1;

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
    const chosen = G.daily ? G.daily.value : G.settings.draw;
    const draw = DRAWS.includes(chosen) ? chosen : 1;
    return {
      stock: deck.slice(k), waste: [], foundations: [[], [], [], []],
      tableau, hidden: tableau.map(col => col.length - 1), draw, moves: 0,
    };
  }

  function locate(id) {
    const state = G.state;
    let i;
    if ((i = state.stock.indexOf(id)) >= 0) return { type: 'stock', pos: i };
    if ((i = state.waste.indexOf(id)) >= 0) return { type: 'waste', pos: i };
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
      case 'found': return s.foundations[ref.idx];
      case 'tableau': return s.tableau[ref.idx];
    }
    return [];
  }

  // The cards that come along when picking up the card at `loc`, or null if it can't be picked up.
  // A foundation's top card may be taken back down to the tableau.
  function grab(loc) {
    if (loc.type === 'stock') return null;
    const pile = pileOf(loc);
    if (loc.type === 'tableau') {
      return loc.pos >= G.state.hidden[loc.idx] && isRun(pile, loc.pos) ? pile.slice(loc.pos) : null;
    }
    return loc.pos === pile.length - 1 ? [pile[loc.pos]] : null;
  }

  function canDrop(ids, from, to) {
    if (same(from, to)) return false;
    const first = ids[0];
    if (to.type === 'tableau') {
      const col = G.state.tableau[to.idx];
      return col.length ? fits(first, last(col)) : card(first).rank === 13;
    }
    if (to.type === 'found') {
      return ids.length === 1 && card(first).suit === to.idx && canFound(first);
    }
    return false;
  }

  // Taking cards off a column turns over the face-down card they uncover.
  function take(s, from, count) {
    const pile = pileOf(from, s);
    const ids = pile.splice(pile.length - count, count);
    if (from.type === 'tableau') s.hidden[from.idx] = Math.min(s.hidden[from.idx], Math.max(0, pile.length - 1));
    return ids;
  }

  const put = (s, to, ids) => pileOf(to, s).push(...ids);

  // Turn the next cards from the stock onto the waste, or the whole waste back over once the
  // stock is empty. Redeals are unlimited.
  function turnStock(s) {
    if (s.stock.length) {
      const n = Math.min(s.draw, s.stock.length);
      for (let i = 0; i < n; i++) s.waste.push(s.stock.pop());
    } else {
      s.stock = s.waste.reverse();
      s.waste = [];
    }
  }

  // ---------- Actions ----------

  function draw() {
    const state = G.state;
    if (G.busy || G.meta.won || (!state.stock.length && !state.waste.length)) return;
    G.snapshot();
    turnStock(state);
    state.moves++;
    G.committed(false, false, AUTO_AFTER_FLIP);
    if (state.stock.length) G.bump(G.slots.badge);
  }

  // Click / tap: the best legal spot for the card (and its run). Foundation cards only come
  // back down by dragging.
  function clickTarget(from, ids) {
    if (from.type === 'found') return null;
    const state = G.state;
    const tries = [];
    if (ids.length === 1) tries.push({ type: 'found', idx: card(ids[0]).suit });
    for (let c = 0; c < 7; c++) if (state.tableau[c].length) tries.push({ type: 'tableau', idx: c });
    if (!(from.type === 'tableau' && from.pos === 0)) {
      const empty = state.tableau.findIndex(col => !col.length);
      if (empty >= 0) tries.push({ type: 'tableau', idx: empty });
    }
    return tries.find(t => canDrop(ids, from, t)) || null;
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
    if (s.waste.length) sources.push({ from: { type: 'waste' }, id: last(s.waste) });
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

  // The next step of an auto-finish: a card home, a turn of the stock, or null when done.
  // `idle` counts the stock turns since the last card went home.
  function nextFinishStep(s, idle) {
    const m = nextFoundationMove(s);
    if (m) return m;
    if (!s.stock.length && !s.waste.length) return null;
    return idle > 2 * (s.stock.length + s.waste.length) + 2 ? null : { draw: true };
  }

  // Auto-finish is offered once every card is face up and playing straight home wins.
  function canAutoFinish() {
    if (G.meta.won || hiddenCount() || foundCount() === 52) return false;
    const s = JSON.parse(JSON.stringify(G.state));
    let m;
    let idle = 0;
    while ((m = nextFinishStep(s, idle))) {
      if (m.draw) {
        turnStock(s);
        idle++;
      } else {
        put(s, m.to, take(s, m.from, 1));
        idle = 0;
      }
    }
    return foundCount(s) === 52;
  }

  function autoFinish() {
    if (G.busy || !canAutoFinish()) return;
    G.busy = true;
    $('#btn-auto').classList.add('hidden');
    let idle = 0;
    const step = () => {
      const m = nextFinishStep(G.state, idle);
      if (!m) {
        G.busy = false;
        G.updateHud();
        return;
      }
      if (m.draw) {
        idle++;
        G.snapshot();
        turnStock(G.state);
        G.state.moves++;
        G.committed(false, true);
      } else {
        idle = 0;
        G.move(m.from, m.ids, m.to);
      }
      if (!G.meta.won) setTimeout(step, 115); // on a win the celebration takes over
    };
    step();
  }

  // ---------- Hints ----------

  // Could any card still in the stock or waste be played somewhere right now?
  function deckHasPlay() {
    const state = G.state;
    const hasEmpty = state.tableau.some(col => !col.length);
    return [...state.stock, ...state.waste].some(id =>
      canFound(id) ||
      (hasEmpty && card(id).rank === 13) ||
      state.tableau.some(col => col.length && fits(id, last(col))));
  }

  function findHints() {
    const state = G.state;
    const out = [];
    const sources = [];
    if (state.waste.length) sources.push({ from: { type: 'waste' }, ids: [last(state.waste)] });
    state.tableau.forEach((col, c) => {
      for (let i = state.hidden[c]; i < col.length; i++) {
        if (isRun(col, i)) sources.push({ from: { type: 'tableau', idx: c, pos: i }, ids: col.slice(i) });
      }
    });

    const firstEmpty = state.tableau.findIndex(col => !col.length);

    for (const src of sources) {
      const { from, ids } = src;
      const base = ids[0];
      const single = ids.length === 1;
      const col = from.type === 'tableau' ? state.tableau[from.idx] : null;
      const below = col && from.pos > 0 ? col[from.pos - 1] : null;
      const reveals = col && from.pos > 0 && from.pos === state.hidden[from.idx];
      const belowToFound = below !== null && !reveals && canFound(below);

      if (single && canFound(base)) {
        out.push({ ...src, to: { type: 'found', idx: card(base).suit }, score: reveals ? 100 : 90 });
      }

      for (let c = 0; c < 7; c++) {
        const target = state.tableau[c];
        if (!target.length || (from.type === 'tableau' && from.idx === c)) continue;
        if (!fits(base, last(target))) continue;
        let score;
        if (reveals) score = 80;
        else if (from.type === 'waste') score = 60;
        else if (from.pos === 0) score = 35; // empties a column
        else if (belowToFound) score = 48;
        else continue; // shuffling a run between equal parents gains nothing
        out.push({ ...src, to: { type: 'tableau', idx: c }, score });
      }

      // Only a king may fill an empty column, and moving one off a bare column gains nothing.
      if (firstEmpty >= 0 && card(base).rank === 13 && !(from.type === 'tableau' && from.pos === 0)) {
        let score = null;
        if (reveals) score = 75;
        else if (from.type === 'waste') score = 58;
        else if (belowToFound) score = 40;
        if (score !== null) out.push({ ...src, to: { type: 'tableau', idx: firstEmpty }, score });
      }
    }

    if ((state.stock.length || state.waste.length) && deckHasPlay()) {
      const el = state.stock.length ? G.els[last(state.stock)] : G.slots.stock;
      out.push({ draw: true, el, score: 20 });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function describe(h) {
    if (h.draw) {
      if (!G.state.stock.length) return 'Turn the waste back over to deal again';
      return G.state.draw === 1 ? 'Draw a card from the deck' : `Draw ${WORDS[G.state.draw]} from the deck`;
    }
    const what = nameOf(h.ids[0]) + (h.ids.length > 1 ? ` and the ${h.ids.length - 1} below it` : '');
    const pile = pileOf(h.to);
    let where;
    if (h.to.type === 'found') where = 'to its foundation';
    else where = pile.length ? `onto ${nameOf(last(pile))}` : 'into the empty column';
    return `Move ${what} ${where}`;
  }

  function targetEl(to) {
    const pile = pileOf(to);
    if (pile.length) return G.els[last(pile)];
    return to.type === 'found' ? G.slots.found[to.idx] : G.slots.tab[to.idx];
  }

  // ---------- Layout & rendering ----------

  const colX = c => c * (G.L.cw + G.L.gap);

  function layout(availW, availH) {
    const gapR = 0.16;
    let cw = availW / (7 + 6 * gapR);
    cw = Math.min(cw, 128, availH / 1.4 / 3.8);
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

    // Waste: the newest cards are fanned far enough apart to read each one's rank and suit
    // (a "10" is the widest corner); older cards beyond what the row holds tuck squarely under them.
    const n = state.waste.length;
    const step = cw * 0.36;
    const spread = 1 + Math.floor((colX(3) - colX(1) - G.L.gap - cw) / step);
    state.waste.forEach((id, i) => {
      const x = Math.round(colX(1) + Math.max(0, i - (n - spread)) * step);
      out[id] = { x, y: top, z: 100 + i, down: false, key: 'w', locked: i < n - 1 };
    });

    state.foundations.forEach((f, fi) => {
      f.forEach((id, i) => {
        out[id] = { x: colX(3 + fi), y: top, z: 200 + i, down: false, key: 'f' + fi };
      });
    });

    // Face-down cards fan tighter than face-up ones; long columns squeeze both to fit.
    const room = G.L.h - G.L.tabY - ch - 8;
    state.tableau.forEach((col, c) => {
      const downs = state.hidden[c];
      const ups = col.length - downs;
      let dOff = ch * 0.12;
      let uOff = ch * 0.27;
      const need = downs * dOff + Math.max(0, ups - 1) * uOff;
      if (need > room) {
        const k = room / need;
        dOff = Math.max(ch * 0.05, dOff * k);
        uOff = Math.max(ch * 0.1, uOff * k);
      }
      let runStart = col.length - 1;
      while (runStart > downs && fits(col[runStart], col[runStart - 1])) runStart--;
      let y = G.L.tabY;
      col.forEach((id, i) => {
        const down = i < downs;
        out[id] = { x: colX(c), y: Math.round(y), z: 400 + i, down, key: 't' + c, locked: !down && i < runStart };
        y += down ? dOff : uOff;
      });
    });
    return out;
  }

  function afterRender() {
    const { slots, state } = G;
    slots.stock.classList.toggle('recycle', !state.stock.length && state.waste.length > 0);
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
    else if (c.rank > 10) center = `<div class="center court"><span class="cl">${r}</span><span class="cs">${s}</span></div>`;
    else center = `<div class="center pip"><span>${s}</span></div>`;
    const idx = pos => `<div class="idx ${pos}"><span class="r">${r}</span><span class="s">${s}</span></div>`;
    return `${idx('top')}${center}${idx('bot')}`;
  }

  function buildSlots() {
    const { slots, board } = G;
    slots.stock = G.makeSlot('stock', '<svg class="recycle-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg>');
    slots.track = G.makeSlot('track', '<span>Waste</span>');
    slots.found = SUITS.map((s, i) => G.makeSlot('found ' + s.color, `<span>${suitSVG(i)}</span>`));
    slots.tab = Array.from({ length: 7 }, () => G.makeSlot('tab', '<span class="king">K</span>'));
    slots.badge = document.createElement('div');
    slots.badge.className = 'badge';
    board.appendChild(slots.badge);
  }

  // ---------- HUD, rules & settings ----------

  function updateHud() {
    // While safe auto-play still has a card to send home, it's about to move on its own.
    const autoPending = G.settings.autoSafe && !!nextFoundationMove(G.state, isSafeHome);
    $('#btn-auto').classList.toggle('hidden', G.busy || autoPending || !canAutoFinish());
    $('#draw-mode').textContent = G.state.draw;
  }

  function validState(s) {
    const all = [...s.stock, ...s.waste, ...s.foundations.flat(), ...s.tableau.flat()];
    return all.length === 52 && new Set(all).size === 52 && DRAWS.includes(s.draw) &&
      s.hidden.length === 7 && s.hidden.every((h, c) => h >= 0 && h < Math.max(1, s.tableau[c].length));
  }

  function winOrder() {
    const order = [];
    for (let r = 12; r >= 0; r--) for (let f = 0; f < 4; f++) order.push(G.state.foundations[f][r]);
    return order;
  }

  const rulesHTML = () => `
    <h2>How to play</h2>
    <p class="sub">The classic. Turn cards from the deck, uncover the columns, and build every suit home.</p>
    <h3>Goal</h3>
    <ul><li>Build all four foundations, one per suit, from Ace up to King.</li></ul>
    <h3>The table</h3>
    <ul>
      <li>Seven columns are dealt with 1 to 7 cards. Only the top card of each starts face up; the other 24 cards form the deck.</li>
      <li>Stack cards in the columns in descending rank with alternating colours (red on black, black on red).</li>
      <li>An ordered run can be moved together. Only a King, or a run headed by one, may fill an empty column.</li>
      <li>When a face-down card is uncovered, it turns over.</li>
      <li>A foundation's top card can be dragged back down onto a column if you need it.</li>
    </ul>
    <h3>The deck</h3>
    <ul>
      <li>The deck turns over 1, 2 or 3 cards at a time; choose which in Settings. Only the top card of the waste can be played.</li>
      <li>When the deck runs out, tap its empty spot to turn the waste back over. You can go through the deck as often as you like.</li>
      <li>This game is set to draw ${G.state.draw}.</li>
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

  // A little fan of n cards for the deal picker.
  const fanIcon = n =>
    `<span class="deal-fan">${Array.from({ length: n }, (_, k) => `<i style="--k: ${k - (n - 1) / 2}"></i>`).join('')}</span>`;

  // ---------- Start ----------

  G = Solitaire.createGame({
    id: 'klondike',
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
    wire: () => {
      $('#btn-auto').addEventListener('click', autoFinish);
      G.slots.stock.addEventListener('click', () => { if (!G.state.stock.length) draw(); });
    },
    rulesHTML,
    settingsDefaults: { autoSafe: true, draw: 1 },
    settingsHTML,
    onSetting,
    dealOptions: {
      key: 'draw',
      title: 'Cards per draw',
      prompt: 'How many cards should the deck turn over at a time?',
      choices: [
        { value: 1, label: 'Draw 1', sub: 'Relaxed', icon: fanIcon(1) },
        { value: 2, label: 'Draw 2', sub: 'In between', icon: fanIcon(2) },
        { value: 3, label: 'Draw 3', sub: 'Classic challenge', icon: fanIcon(3) },
      ],
    },
  });

  G.start();
})();
