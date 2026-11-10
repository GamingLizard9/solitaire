(() => {
  'use strict';

  const { SUITS, TEXT_STYLE, suitSVG, last, same, place, shuffle } = Solitaire;

  // ---------- Card data ----------

  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const COLS = 10;
  const RUN = 13;   // a full run, King down to Ace
  const SETS = 8;   // two decks' worth of runs
  const SUIT_COUNTS = [1, 2, 4];

  // Two decks: 104 cards in eight sets of Ace to King. Which suit a set wears depends on how
  // many suits the deal is played with (see dress), so the same cards serve every variation.
  const CARDS = [];
  for (let i = 0; i < SETS * RUN; i++) {
    CARDS.push({ id: i, set: Math.floor(i / RUN), rank: (i % RUN) + 1, suit: 0, color: SUITS[0].color });
  }

  const $ = sel => document.querySelector(sel);

  // The shared engine's table. G.state is { stock, tableau[10], hidden[10], foundations, suits,
  // moves }: hidden[c] counts the face-down cards at the bottom of column c, and foundations
  // holds each completed run, King first.
  let G;

  // ---------- Suits ----------

  const cardLabel = c => `${RANKS[c.rank - 1]} of ${SUITS[c.suit].name}`;

  // Give every card the suit it has in an n-suit game: all Spades, Spades and Hearts, or all four.
  let dressed = 1;
  function dress(n) {
    if (dressed === n) return;
    dressed = n;
    for (const c of CARDS) {
      c.suit = c.set % n;
      c.color = SUITS[c.suit].color;
      const el = G.els[c.id];
      el.classList.remove('red', 'black');
      el.classList.add(c.color);
      el.setAttribute('aria-label', cardLabel(c));
      el.querySelector('.face').innerHTML = faceHTML(c);
    }
  }

  // ---------- Rules helpers ----------

  const card = id => CARDS[id];
  const nameOf = id => RANKS[card(id).rank - 1] + SUITS[card(id).suit].sym + TEXT_STYLE;

  // Can `lower` be placed directly onto `upper`? Any suit will do.
  const fits = (lower, upper) => card(upper).rank === card(lower).rank + 1;
  // Do they also share a suit, so that they can move on together?
  const suited = (lower, upper) => fits(lower, upper) && card(upper).suit === card(lower).suit;

  function isRun(col, from) {
    for (let j = from + 1; j < col.length; j++) if (!suited(col[j], col[j - 1])) return false;
    return true;
  }

  // Where the movable run at the end of a column begins.
  function runStart(col, hidden) {
    let i = col.length - 1;
    while (i > hidden && suited(col[i], col[i - 1])) i--;
    return i;
  }

  // The first column that ends in a full King-to-Ace run of one suit, or -1.
  function completedColumn(s) {
    return s.tableau.findIndex((col, c) => {
      const start = col.length - RUN;
      return start >= s.hidden[c] && card(col[start]).rank === RUN && isRun(col, start);
    });
  }

  function freshState() {
    const deck = shuffle([...Array(CARDS.length).keys()]);
    const tableau = Array.from({ length: COLS }, () => []);
    let k = 0;
    while (k < 54) tableau[k % COLS].push(deck[k++]);
    const chosen = G.daily ? G.daily.value : G.settings.suits;
    const suits = SUIT_COUNTS.includes(chosen) ? chosen : 1;
    return {
      stock: deck.slice(k), tableau, hidden: tableau.map(col => col.length - 1),
      foundations: [], suits, moves: 0,
    };
  }

  function locate(id) {
    const state = G.state;
    let i;
    if ((i = state.stock.indexOf(id)) >= 0) return { type: 'stock', pos: i };
    for (let c = 0; c < COLS; c++) {
      if ((i = state.tableau[c].indexOf(id)) >= 0) return { type: 'tableau', idx: c, pos: i };
    }
    for (let f = 0; f < state.foundations.length; f++) {
      if ((i = state.foundations[f].indexOf(id)) >= 0) return { type: 'found', idx: f, pos: i };
    }
    return null;
  }

  // The cards that come along when picking up the card at `loc`, or null if it can't be picked
  // up. Only a run of one suit moves together.
  function grab(loc) {
    if (loc.type !== 'tableau') return null;
    const col = G.state.tableau[loc.idx];
    return loc.pos >= G.state.hidden[loc.idx] && isRun(col, loc.pos) ? col.slice(loc.pos) : null;
  }

  function canDrop(ids, from, to) {
    if (to.type !== 'tableau' || same(from, to)) return false;
    const col = G.state.tableau[to.idx];
    return !col.length || fits(ids[0], last(col));
  }

  // Taking cards off a column turns over the face-down card they uncover.
  function take(s, from, count) {
    const col = s.tableau[from.idx];
    const ids = col.splice(col.length - count, count);
    s.hidden[from.idx] = Math.min(s.hidden[from.idx], Math.max(0, col.length - 1));
    return ids;
  }

  // ---------- Actions ----------

  // Deal one more card onto every column. As in the card-table game, every column must hold a
  // card first (unless there are too few cards left on the table to manage that).
  function dealRow() {
    const state = G.state;
    if (G.busy || G.meta.won || !state.stock.length) return;
    const onTable = state.tableau.reduce((n, col) => n + col.length, 0);
    if (onTable >= COLS && state.tableau.some(col => !col.length)) {
      G.toast('Fill every empty column before dealing a new row');
      return;
    }
    G.snapshot();
    const stagger = {};
    for (let c = 0; c < COLS; c++) {
      const id = state.stock.pop();
      state.tableau[c].push(id);
      stagger[id] = c * 45;
    }
    state.moves++;
    G.render({ stagger }); // the row goes out one card after another
    G.committed();
  }

  // Click / tap: the best legal spot for the card (and its run). A card of the same suit comes
  // first, the one with the longest run behind it; then any card it follows; then an empty column.
  function clickTarget(from, ids) {
    const state = G.state;
    const first = ids[0];
    let best = null;
    let bestScore = 0;
    state.tableau.forEach((col, c) => {
      if (c === from.idx || !col.length || !fits(first, last(col))) return;
      const match = card(last(col)).suit === card(first).suit;
      const score = match ? 100 + col.length - runStart(col, state.hidden[c]) : 1;
      if (score > bestScore) {
        bestScore = score;
        best = { type: 'tableau', idx: c };
      }
    });
    if (best || from.pos === 0) return best;
    const empty = state.tableau.findIndex(col => !col.length);
    return empty >= 0 ? { type: 'tableau', idx: empty } : null;
  }

  // ---------- Completed runs ----------

  // A full run leaves the table on its own as soon as it's assembled.
  function nextAuto() {
    const state = G.state;
    const c = completedColumn(state);
    if (c < 0) return null;
    const col = state.tableau[c];
    const from = { type: 'tableau', idx: c, pos: col.length - RUN };
    const step = () => { state.foundations.push(take(state, from, RUN)); };
    return Object.assign(step, { ids: col.slice(-RUN), to: { type: 'found', idx: state.foundations.length }, cue: 420 });
  }

  // ---------- Hints ----------

  function findHints() {
    const state = G.state;
    const out = [];
    const firstEmpty = state.tableau.findIndex(col => !col.length);
    const toEmpty = { type: 'tableau', idx: firstEmpty };

    state.tableau.forEach((col, c) => {
      if (!col.length) return;
      const pos = runStart(col, state.hidden[c]);
      const ids = col.slice(pos);
      const base = ids[0];
      const from = { type: 'tableau', idx: c, pos };
      const below = pos > 0 ? col[pos - 1] : null;
      const reveals = pos > 0 && pos === state.hidden[c];
      // Already resting on a card it follows, just not one of its suit.
      const settled = below !== null && !reveals && fits(base, below);

      state.tableau.forEach((target, t) => {
        if (t === c || !target.length || !fits(base, last(target))) return;
        const match = card(last(target)).suit === card(base).suit;
        let score;
        if (match) score = 70 + (reveals ? 25 : pos === 0 ? 20 : 0) + Math.min(ids.length, 4);
        else if (reveals) score = 60;
        else if (pos === 0) score = 50; // empties a column
        else if (!settled) score = 30;
        else return; // swapping one off-suit parent for another gains nothing
        out.push({ from, ids, to: { type: 'tableau', idx: t }, score });
      });

      // Moving a whole column into an empty one gains nothing.
      if (firstEmpty >= 0 && pos > 0) out.push({ from, ids, to: toEmpty, score: reveals ? 40 : settled ? 8 : 20 });
    });

    if (state.stock.length) {
      if (firstEmpty < 0) out.push({ deal: true, el: G.els[last(state.stock)], score: 10 });
      else if (!out.some(h => same(h.to, toEmpty))) {
        // Every column is one tidy run, but the empty one must be filled before the next deal.
        const c = state.tableau.reduce((b, col, i) => (col.length > state.tableau[b].length ? i : b), 0);
        const col = state.tableau[c];
        if (col.length > 1) out.push({ from: { type: 'tableau', idx: c, pos: col.length - 1 }, ids: [last(col)], to: toEmpty, score: 5 });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function describe(h) {
    if (h.deal) return 'Deal a new row of cards';
    const what = nameOf(h.ids[0]) + (h.ids.length > 1 ? ` and the ${h.ids.length - 1} below it` : '');
    const col = G.state.tableau[h.to.idx];
    return `Move ${what} ${col.length ? `onto ${nameOf(last(col))}` : 'into the empty column'}`;
  }

  function targetEl(to) {
    if (to.type === 'found') return G.slots.found[to.idx];
    const col = G.state.tableau[to.idx];
    return col.length ? G.els[last(col)] : G.slots.tab[to.idx];
  }

  // ---------- Layout & rendering ----------

  const colX = c => c * (G.L.cw + G.L.gap);
  // Completed runs line up along the top, from the right of the stock.
  const foundX = f => colX(COLS - SETS + f);

  function layout(availW, availH) {
    const gapR = 0.1;
    let cw = availW / (COLS + (COLS - 1) * gapR);
    cw = Math.min(cw, 118, availH / 1.4 / 4.3);
    cw = Math.floor(Math.max(cw, 30));
    const ch = Math.round(cw * 1.4);
    const gap = Math.round(cw * gapR);
    const top = 6;
    G.L = {
      cw, ch, gap, top, w: COLS * cw + (COLS - 1) * gap, h: availH,
      tabY: top + ch + Math.max(Math.round(gap * 1.6), 14),
    };

    const { slots } = G;
    place(slots.stock, 0, top);
    slots.found.forEach((el, f) => place(el, foundX(f), top));
    slots.tab.forEach((el, c) => place(el, colX(c), G.L.tabY));
  }

  function positions() {
    const state = G.state;
    dress(state.suits);
    const out = {};
    const { cw, ch, top } = G.L;

    // The stock sits in packets of ten, one per deal still to come, fanned so they can be counted.
    const fan = Math.round(cw * 0.2);
    state.stock.forEach((id, i) => {
      out[id] = { x: Math.floor(i / COLS) * fan, y: top, z: 10 + i, down: true, key: 's' };
    });

    // A completed run rests with its King on top.
    state.foundations.forEach((run, f) => {
      run.forEach((id, i) => {
        out[id] = { x: foundX(f), y: top, z: 200 + f * RUN + (RUN - 1 - i), down: false, key: 'f' + f };
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
        dOff = Math.max(ch * 0.04, dOff * k);
        uOff = Math.max(ch * 0.085, uOff * k);
      }
      const start = runStart(col, downs);
      let y = G.L.tabY;
      col.forEach((id, i) => {
        const down = i < downs;
        out[id] = { x: colX(c), y: Math.round(y), z: 400 + i, down, key: 't' + c, locked: !down && i < start };
        y += down ? dOff : uOff;
      });
    });
    return out;
  }

  function dropZones() {
    const { L, P, state } = G;
    return state.tableau.map((col, c) => ({
      to: { type: 'tableau', idx: c },
      x: colX(c), y: col.length ? P[last(col)].y : L.tabY, w: L.cw, h: L.ch * 1.5,
    }));
  }

  function dealOrder() {
    const order = [];
    for (let row = 0; row < 6; row++) {
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
    slots.stock = G.makeSlot('stock');
    slots.found = Array.from({ length: SETS }, () => G.makeSlot('found', '<span>K</span>'));
    slots.tab = Array.from({ length: COLS }, () => G.makeSlot('tab'));
  }

  // ---------- HUD & rules ----------

  function updateHud() {
    $('#suit-mode').textContent = G.state.suits;
  }

  function validState(s) {
    const all = [...s.stock, ...s.tableau.flat(), ...s.foundations.flat()];
    return all.length === CARDS.length && new Set(all).size === CARDS.length &&
      SUIT_COUNTS.includes(s.suits) && s.stock.length % COLS === 0 &&
      s.tableau.length === COLS && s.foundations.every(run => run.length === RUN) &&
      s.hidden.length === COLS && s.hidden.every((h, c) => h >= 0 && h < Math.max(1, s.tableau[c].length));
  }

  const SUIT_WORDS = { 1: 'one suit', 2: 'two suits', 4: 'four suits' };

  const rulesHTML = () => `
    <h2>How to play</h2>
    <p class="sub">Two decks, ten columns. Assemble eight full runs, King down to Ace, and clear the table.</p>
    <h3>Goal</h3>
    <ul><li>Build a run of one suit from King down to Ace. A finished run leaves the table; clear all eight to win.</li></ul>
    <h3>The table</h3>
    <ul>
      <li>54 cards are dealt into ten columns, with only the top card of each face up. The other 50 wait in the stock.</li>
      <li>A card can go onto any card one rank higher, whatever its suit.</li>
      <li>Only a run of a single suit can be moved together, so mixing suits ties cards down.</li>
      <li>Any card or run may fill an empty column.</li>
      <li>When a face-down card is uncovered, it turns over.</li>
    </ul>
    <h3>The stock</h3>
    <ul>
      <li>Tap the stock to deal one more card onto every column. There are five deals.</li>
      <li>Every column must hold at least one card before you can deal.</li>
    </ul>
    <h3>Suits</h3>
    <ul>
      <li>Play with one suit (easiest), two, or all four (hardest); choose in Settings.</li>
      <li>This game uses ${SUIT_WORDS[G.state.suits]}.</li>
    </ul>
    <h3>Controls</h3>
    <ul>
      <li>Drag cards to move them, or tap a card to send it to the best legal spot.</li>
      <li><kbd>Space</kbd> deal · <kbd>Z</kbd> undo · <kbd>H</kbd> hint · <kbd>N</kbd> new game · <kbd>R</kbd> rules · <kbd>S</kbd> settings</li>
    </ul>`;

  // The suits in play, for the deal picker.
  const suitsIcon = n =>
    `<span class="deal-suits">${Array.from({ length: n }, (_, s) => `<i class="${SUITS[s].color}">${suitSVG(s)}</i>`).join('')}</span>`;

  // ---------- Start ----------

  G = Solitaire.createGame({
    id: 'spider',
    cards: CARDS,
    cardLabel,
    faceHTML,
    buildSlots,
    layout,
    positions,
    freshState,
    validState,
    isWon: () => G.state.foundations.length === SETS,
    winOrder: () => G.state.foundations.flat().reverse(),
    winText: 'All eight runs are complete, king to ace.',
    locate,
    grab,
    canDrop,
    apply: (s, from, ids, to) => s.tableau[to.idx].push(...take(s, from, ids.length)),
    dropZones,
    targetEl,
    clickTarget,
    findHints,
    describe,
    dealOrder,
    dealFrom: () => ({ x: 0, y: G.L.top, key: 's' }),
    nextAuto,
    press: (id, loc) => {
      if (loc.type !== 'stock') return false;
      dealRow();
      return true;
    },
    updateHud,
    onKey: (key, e) => {
      if (key !== ' ' && key !== 'd') return;
      e.preventDefault();
      dealRow();
    },
    rulesHTML,
    settingsDefaults: { suits: 1 },
    dealOptions: {
      key: 'suits',
      title: 'Suits',
      prompt: 'How many suits would you like to play with?',
      choices: [
        { value: 1, label: '1 Suit', sub: 'Easy', icon: suitsIcon(1) },
        { value: 2, label: '2 Suits', sub: 'Medium', icon: suitsIcon(2) },
        { value: 4, label: '4 Suits', sub: 'Hard', icon: suitsIcon(4) },
      ],
    },
  });

  G.start();
})();
