// Solvers for the Daily Deal: given a shuffled deck, look for a way to win under the game's rules.
// They run ahead of time in tools/build-daily.js, never in the browser. A solver only has to find
// wins, not prove losses: a deal it gives up on is simply skipped for the next try.
//
// Each returns a list of moves or null. A move is { card, to } (pick up `card` with whatever sits
// on it and drop it at `to`, using the games' own location objects) or { draw: true }.
'use strict';

const BUDGET = 150000; // positions to look at before giving up on a deal

// ---------- Best-first search ----------

// Binary heap of [priority, order, node]; ties go to the newest, which keeps the search digging.
class Heap {
  constructor() { this.a = []; this.n = 0; }
  get size() { return this.a.length; }
  less(x, y) { return x[0] < y[0] || (x[0] === y[0] && x[1] > y[1]); }
  push(item) {
    const a = this.a;
    let i = a.push(item) - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const end = a.pop();
    if (a.length) {
      a[0] = end;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

// `rules` supplies next(state) -> [{ state, moves }], key(state), score(state) (lower is closer to
// winning) and won(state). A longer line costs a little, so the search doesn't wander forever.
function search(start, rules, budget = BUDGET) {
  const heap = new Heap();
  const seen = new Set([rules.key(start)]);
  let order = 0;
  heap.push([rules.score(start), order++, { state: start, parent: null, moves: [], depth: 0 }]);
  for (let looked = 0; heap.size && looked < budget; looked++) {
    const node = heap.pop()[2];
    if (rules.won(node.state)) {
      const lines = [];
      for (let n = node; n; n = n.parent) lines.push(n.moves);
      return lines.reverse().flat();
    }
    for (const { state, moves } of rules.next(node.state)) {
      const key = rules.key(state);
      if (seen.has(key)) continue;
      seen.add(key);
      const depth = node.depth + 1;
      heap.push([rules.score(state) + depth * (rules.depthCost || 0), order++, { state, parent: node, moves, depth }]);
    }
  }
  return null;
}

// ---------- The standard 52-card deck ----------

const suit = id => Math.floor(id / 13);
const rank = id => id % 13 + 1;
const red = id => suit(id) % 2 === 1; // hearts and diamonds
const fits = (lower, upper) => rank(upper) === rank(lower) + 1 && red(upper) !== red(lower);
const last = a => a[a.length - 1];
const homeCount = f => f[0] + f[1] + f[2] + f[3];

// The games' safe auto-play test: nothing could still need this card in the columns.
function safeHome(id, f) {
  const r = rank(id);
  const s = suit(id);
  if (r !== f[s] + 1) return false;
  const opp = Math.min(f[(s + 1) % 4], f[(s + 3) % 4]);
  const twin = f[(s + 2) % 4];
  return opp >= r - 1 || (opp >= r - 2 && twin >= r - 3);
}

const withHome = (f, id) => {
  const out = f.slice();
  out[suit(id)]++;
  return out;
};

const replaced = (a, i, value) => {
  const out = a.slice();
  out[i] = value;
  return out;
};

const runStart = (col, floor) => {
  let i = col.length - 1;
  while (i > floor && fits(col[i], col[i - 1])) i--;
  return i;
};

// How many cards still sit on top of the next card each suit needs.
function digDepth(t, f) {
  let total = 0;
  for (const col of t) {
    for (let i = 0; i < col.length; i++) {
      if (rank(col[i]) === f[suit(col[i])] + 1) total += col.length - 1 - i;
    }
  }
  return total;
}

// ---------- Klondike ----------

// Deal the columns the way klondike/game.js and clearview/game.js do.
function dealTriangle(deck) {
  const t = Array.from({ length: 7 }, () => []);
  let k = 0;
  for (let row = 0; row < 7; row++) {
    for (let c = row; c < 7; c++) t[c].push(deck[k++]);
  }
  return { t, stock: deck.slice(k) };
}

function klondikeNext(s) {
  const out = [];
  const homeFromColumn = (c, moves = []) => {
    const col = s.t[c];
    const id = last(col);
    const rest = col.slice(0, -1);
    return {
      state: { ...s, t: replaced(s.t, c, rest), h: replaced(s.h, c, Math.min(s.h[c], Math.max(0, rest.length - 1))), f: withHome(s.f, id) },
      moves: [...moves, { card: id, to: { type: 'found', idx: suit(id) } }],
    };
  };

  // A card that's safe to send home is always the right move.
  for (let c = 0; c < 7; c++) {
    if (s.t[c].length && safeHome(last(s.t[c]), s.f)) return [homeFromColumn(c)];
  }
  if (s.waste.length && safeHome(last(s.waste), s.f)) {
    const id = last(s.waste);
    return [{ state: { ...s, waste: s.waste.slice(0, -1), f: withHome(s.f, id) }, moves: [{ card: id, to: { type: 'found', idx: suit(id) } }] }];
  }

  for (let c = 0; c < 7; c++) {
    const col = s.t[c];
    if (!col.length) continue;
    const id = last(col);
    if (rank(id) === s.f[suit(id)] + 1) out.push(homeFromColumn(c));
    const first = Math.max(s.h[c], runStart(col, s.h[c]));
    for (let i = first; i < col.length; i++) {
      const base = col[i];
      const rest = col.slice(0, i);
      // Moving a run off a card it already sits on only helps if that lets the card go home.
      const useful = i === s.h[c] || rank(col[i - 1]) === s.f[suit(col[i - 1])] + 1;
      if (!useful) continue;
      const h = replaced(s.h, c, Math.min(s.h[c], Math.max(0, rest.length - 1)));
      let usedEmpty = false;
      for (let d = 0; d < 7; d++) {
        if (d === c) continue;
        const target = s.t[d];
        const empty = !target.length;
        if (empty ? rank(base) !== 13 || !rest.length || usedEmpty : !fits(base, last(target))) continue;
        if (empty) usedEmpty = true;
        const t = replaced(replaced(s.t, c, rest), d, target.concat(col.slice(i)));
        out.push({ state: { ...s, t, h }, moves: [{ card: base, to: { type: 'tableau', idx: d } }] });
      }
    }
  }

  // Everything the deck can offer: turn cards until each reachable card is on top, then play it.
  let stock = s.stock;
  let waste = s.waste;
  const draws = [];
  const total = stock.length + waste.length;
  const limit = total ? 2 * (Math.ceil(total / s.draw) + 1) : 0;
  for (let turn = 0; turn <= limit; turn++) {
    if (waste.length) {
      const id = last(waste);
      const rest = waste.slice(0, -1);
      const moves = draws.slice();
      if (rank(id) === s.f[suit(id)] + 1) {
        out.push({ state: { ...s, stock, waste: rest, f: withHome(s.f, id) }, moves: [...moves, { card: id, to: { type: 'found', idx: suit(id) } }] });
      }
      let usedEmpty = false;
      for (let d = 0; d < 7; d++) {
        const target = s.t[d];
        const empty = !target.length;
        if (empty ? rank(id) !== 13 || usedEmpty : !fits(id, last(target))) continue;
        if (empty) usedEmpty = true;
        out.push({ state: { ...s, stock, waste: rest, t: replaced(s.t, d, target.concat(id)) }, moves: [...moves, { card: id, to: { type: 'tableau', idx: d } }] });
      }
    }
    if (!total) break;
    if (stock.length) {
      const n = Math.min(s.draw, stock.length);
      const taken = stock.slice(stock.length - n).reverse();
      stock = stock.slice(0, stock.length - n);
      waste = waste.concat(taken);
    } else {
      stock = waste.slice().reverse();
      waste = [];
    }
    draws.push({ draw: true });
  }
  return out;
}

const klondikeRules = {
  next: klondikeNext,
  key: s => [s.t.map((col, c) => s.h[c] + ':' + col.join(',')).sort().join(';'), s.waste.join(','), s.stock.join(','), s.f.join(',')].join('|'),
  score: s => {
    const hidden = s.h[0] + s.h[1] + s.h[2] + s.h[3] + s.h[4] + s.h[5] + s.h[6];
    const empties = s.t.filter(col => !col.length).length;
    return 10 * hidden + 3 * (52 - homeCount(s.f)) + digDepth(s.t, s.f) + s.stock.length + s.waste.length - 2 * empties;
  },
  won: s => homeCount(s.f) === 52,
  depthCost: 0.02,
};

function solveKlondike(deck, draw) {
  const { t, stock } = dealTriangle(deck);
  return search({ t, h: t.map(col => col.length - 1), stock, waste: [], f: [0, 0, 0, 0], draw }, klondikeRules);
}

// ---------- FreeCell ----------

function freecellNext(s) {
  const out = [];
  const home = id => ({ type: 'found', idx: suit(id) });

  for (let c = 0; c < 8; c++) {
    if (s.t[c].length && safeHome(last(s.t[c]), s.f)) {
      const id = last(s.t[c]);
      return [{ state: { ...s, t: replaced(s.t, c, s.t[c].slice(0, -1)), f: withHome(s.f, id) }, moves: [{ card: id, to: home(id) }] }];
    }
  }
  for (let i = 0; i < 4; i++) {
    const id = s.cells[i];
    if (id !== null && safeHome(id, s.f)) {
      return [{ state: { ...s, cells: replaced(s.cells, i, null), f: withHome(s.f, id) }, moves: [{ card: id, to: home(id) }] }];
    }
  }

  const freeCell = s.cells.indexOf(null);
  const firstEmpty = s.t.findIndex(col => !col.length);

  for (let i = 0; i < 4; i++) {
    const id = s.cells[i];
    if (id === null) continue;
    const cells = replaced(s.cells, i, null);
    if (rank(id) === s.f[suit(id)] + 1) out.push({ state: { ...s, cells, f: withHome(s.f, id) }, moves: [{ card: id, to: home(id) }] });
    for (let d = 0; d < 8; d++) {
      const target = s.t[d];
      if (target.length ? fits(id, last(target)) : d === firstEmpty) {
        out.push({ state: { ...s, cells, t: replaced(s.t, d, target.concat(id)) }, moves: [{ card: id, to: { type: 'tableau', idx: d } }] });
      }
    }
  }

  for (let c = 0; c < 8; c++) {
    const col = s.t[c];
    if (!col.length) continue;
    const id = last(col);
    const rest = col.slice(0, -1);
    const t = replaced(s.t, c, rest);
    if (rank(id) === s.f[suit(id)] + 1) out.push({ state: { ...s, t, f: withHome(s.f, id) }, moves: [{ card: id, to: home(id) }] });
    for (let d = 0; d < 8; d++) {
      if (d === c) continue;
      const target = s.t[d];
      if (target.length ? fits(id, last(target)) : d === firstEmpty && rest.length) {
        out.push({ state: { ...s, t: replaced(t, d, target.concat(id)) }, moves: [{ card: id, to: { type: 'tableau', idx: d } }] });
      }
    }
    if (freeCell >= 0) {
      out.push({ state: { ...s, t, cells: replaced(s.cells, freeCell, id) }, moves: [{ card: id, to: { type: 'cell', idx: freeCell } }] });
    }
  }
  return out;
}

const freecellRules = {
  next: freecellNext,
  key: s => [s.t.map(col => col.join(',')).sort().join(';'), s.cells.filter(id => id !== null).sort((a, b) => a - b).join(','), s.f.join(',')].join('|'),
  score: s => {
    const held = s.cells.filter(id => id !== null).length;
    const empties = s.t.filter(col => !col.length).length;
    let tangled = 0;
    for (const col of s.t) if (col.length) tangled += runStart(col, 0);
    return 4 * (52 - homeCount(s.f)) + 2 * digDepth(s.t, s.f) + tangled + 3 * held - 4 * empties;
  },
  won: s => homeCount(s.f) === 52,
  depthCost: 0.02,
};

function solveFreecell(deck) {
  const t = Array.from({ length: 8 }, () => []);
  deck.forEach((id, k) => t[k % 8].push(id));
  return search({ t, cells: [null, null, null, null], f: [0, 0, 0, 0] }, freecellRules);
}

// ---------- Clearview ----------

function clearviewNext(s) {
  const out = [];
  const home = id => ({ type: 'found', idx: suit(id) });

  // Cards leave for home from the waste, the free cell or a column's end.
  const tops = [];
  if (s.waste.length) tops.push({ id: last(s.waste), lift: { waste: s.waste.slice(0, -1) } });
  if (s.free !== null) tops.push({ id: s.free, lift: { free: null } });
  for (let c = 0; c < 7; c++) {
    if (s.t[c].length) tops.push({ id: last(s.t[c]), col: c, lift: { t: replaced(s.t, c, s.t[c].slice(0, -1)) } });
  }
  for (const { id, lift } of tops) {
    if (safeHome(id, s.f)) return [{ state: { ...s, ...lift, f: withHome(s.f, id) }, moves: [{ card: id, to: home(id) }] }];
  }

  const firstEmpty = s.t.findIndex(col => !col.length);
  for (const { id, lift, col } of tops) {
    if (rank(id) === s.f[suit(id)] + 1) out.push({ state: { ...s, ...lift, f: withHome(s.f, id) }, moves: [{ card: id, to: home(id) }] });
    if (col !== undefined) continue; // columns are handled as runs below
    for (let d = 0; d < 7; d++) {
      const target = s.t[d];
      if (target.length ? fits(id, last(target)) : d === firstEmpty) {
        const t = replaced(s.t, d, target.concat(id));
        out.push({ state: { ...s, ...lift, t }, moves: [{ card: id, to: { type: 'tableau', idx: d } }] });
      }
    }
  }

  for (let c = 0; c < 7; c++) {
    const col = s.t[c];
    if (!col.length) continue;
    const start = runStart(col, 0);
    for (let i = start; i < col.length; i++) {
      const rest = col.slice(0, i);
      for (let d = 0; d < 7; d++) {
        if (d === c) continue;
        const target = s.t[d];
        if (target.length ? !fits(col[i], last(target)) : d !== firstEmpty || !rest.length) continue;
        const t = replaced(replaced(s.t, c, rest), d, target.concat(col.slice(i)));
        out.push({ state: { ...s, t }, moves: [{ card: col[i], to: { type: 'tableau', idx: d } }] });
      }
    }
  }

  // The deck's spot only works as a free cell once the deck is gone.
  if (!s.stock.length && s.free === null) {
    if (s.waste.length) {
      out.push({ state: { ...s, waste: s.waste.slice(0, -1), free: last(s.waste) }, moves: [{ card: last(s.waste), to: { type: 'free' } }] });
    }
    for (let c = 0; c < 7; c++) {
      if (!s.t[c].length) continue;
      out.push({ state: { ...s, t: replaced(s.t, c, s.t[c].slice(0, -1)), free: last(s.t[c]) }, moves: [{ card: last(s.t[c]), to: { type: 'free' } }] });
    }
  }

  if (s.stock.length) {
    const n = Math.min(3, s.stock.length);
    const taken = s.stock.slice(s.stock.length - n).reverse();
    out.push({ state: { ...s, stock: s.stock.slice(0, s.stock.length - n), waste: s.waste.concat(taken) }, moves: [{ draw: true }] });
  }
  return out;
}

const clearviewRules = {
  next: clearviewNext,
  key: s => [s.t.map(col => col.join(',')).sort().join(';'), s.waste.join(','), s.stock.length, s.free, s.f.join(',')].join('|'),
  score: s => {
    const empties = s.t.filter(col => !col.length).length;
    let tangled = 0;
    for (const col of s.t) if (col.length) tangled += runStart(col, 0);
    return 4 * (52 - homeCount(s.f)) + 2 * digDepth(s.t, s.f) + 2 * tangled + s.waste.length + (s.free === null ? 0 : 2) - 3 * empties;
  },
  won: s => homeCount(s.f) === 52,
  depthCost: 0.02,
};

function solveClearview(deck) {
  const { t, stock } = dealTriangle(deck);
  return search({ t, stock, waste: [], free: null, f: [0, 0, 0, 0] }, clearviewRules);
}

// ---------- Quartet ----------

// Ids match quartet/game.js: 0-19 are the 6 to 10 of each suit, 20-35 the face cards.
const qFace = id => id >= 20;
const qSuit = id => (qFace(id) ? Math.floor((id - 20) / 4) : Math.floor(id / 5));
const qRank = id => id % 5 + 6;
const qRed = id => qSuit(id) % 2 === 1;
const qFits = (lower, upper) => {
  if (qFace(lower) || qFace(upper)) return qFace(lower) && qFace(upper) && qSuit(lower) === qSuit(upper);
  return qRank(upper) === qRank(lower) + 1 && qRed(upper) !== qRed(lower);
};
const qRunStart = col => {
  let i = col.length - 1;
  while (i > 0 && qFits(col[i], col[i - 1])) i--;
  return i;
};
const qSealable = col => col.length === 4 && qFace(col[0]) && qRunStart(col) === 0;
const qFullRun = col => col.length === 5 && !qFace(col[0]) && qRank(col[0]) === 10 && qRunStart(col) === 0;

// A fourth face card landing in an otherwise empty column seals it on its own.
function qSeal(s) {
  const sealed = s.sealed.map((done, c) => done || qSealable(s.t[c]));
  return { ...s, sealed };
}

function quartetNext(s) {
  const out = [];
  const firstEmpty = s.t.findIndex((col, c) => !col.length && !s.sealed[c]);

  if (s.free !== null) {
    for (let d = 0; d < 9; d++) {
      if (s.sealed[d]) continue;
      const target = s.t[d];
      if (target.length ? qFits(s.free, last(target)) : d === firstEmpty) {
        out.push({ state: qSeal({ ...s, free: null, t: replaced(s.t, d, target.concat(s.free)) }), moves: [{ card: s.free, to: { type: 'tableau', idx: d } }] });
      }
    }
  }

  for (let c = 0; c < 9; c++) {
    if (s.sealed[c] || !s.t[c].length) continue;
    const col = s.t[c];
    for (let i = qRunStart(col); i < col.length; i++) {
      const rest = col.slice(0, i);
      for (let d = 0; d < 9; d++) {
        if (d === c || s.sealed[d]) continue;
        const target = s.t[d];
        if (target.length ? !qFits(col[i], last(target)) : d !== firstEmpty || !rest.length) continue;
        const t = replaced(replaced(s.t, c, rest), d, target.concat(col.slice(i)));
        out.push({ state: qSeal({ ...s, t }), moves: [{ card: col[i], to: { type: 'tableau', idx: d } }] });
      }
    }
    if (s.free === null) {
      out.push({ state: qSeal({ ...s, free: last(col), t: replaced(s.t, c, col.slice(0, -1)) }), moves: [{ card: last(col), to: { type: 'free' } }] });
    }
  }
  return out;
}

const quartetRules = {
  next: quartetNext,
  // Face cards of a suit are interchangeable, so positions that differ only by which is where are the same.
  key: s => {
    const name = id => (qFace(id) ? 'f' + qSuit(id) : id);
    return s.t.map((col, c) => (s.sealed[c] ? 'S' : '') + col.map(name).join(',')).sort().join(';') + '|' + (s.free === null ? '' : name(s.free));
  },
  score: s => {
    let cost = 0;
    s.t.forEach((col, c) => {
      if (s.sealed[c]) return;
      cost += 2 * qRunStart(col);
      if (col.length && !qFace(col[0]) && qRank(col[0]) !== 10) cost += 2;
    });
    const sealed = s.sealed.filter(Boolean).length;
    const runs = s.t.filter((col, c) => !s.sealed[c] && qFullRun(col)).length;
    return cost + (s.free === null ? 0 : 3) - 6 * sealed - 6 * runs;
  },
  won: s => s.sealed.filter(Boolean).length === 4 && s.t.filter((col, c) => !s.sealed[c] && qFullRun(col)).length === 4,
  depthCost: 0.02,
};

function solveQuartet(deck) {
  const t = Array.from({ length: 9 }, (_, c) => deck.slice(c * 4, c * 4 + 4));
  return search({ t, free: null, sealed: Array(9).fill(false) }, quartetRules);
}

// ---------- Elements ----------

// Ids match elements/game.js: 0-26 are the 1 to 9 of Fire, Water and Earth, 27-38 the face
// cards, 39 the star. A free cell holds null, a card id, or 'S' + suit once a suit has collapsed.
const E_STAR = 39;
const eFace = id => id >= 27 && id < E_STAR;
const eSuit = id => (eFace(id) ? Math.floor((id - 27) / 4) : Math.floor(id / 9));
const eRank = id => id % 9 + 1;
const eNumber = id => id < 27;
const eFits = (lower, upper) => eNumber(lower) && eNumber(upper) && eRank(upper) === eRank(lower) + 1 && eSuit(upper) !== eSuit(lower);
const eRunStart = col => {
  let i = col.length - 1;
  while (i > 0 && eFits(col[i], col[i - 1])) i--;
  return i;
};
const eSealed = cell => typeof cell === 'string';
const eOpen = cell => cell === null;
const eCellFace = (cell, suit) => typeof cell === 'number' && eFace(cell) && eSuit(cell) === suit;

// The game's collapse: all four faces exposed (in a cell or ending a column), gathered into the
// first cell holding one of them, else the first empty cell.
function eCollapse(s, suit) {
  if (s.cells.includes('S' + suit)) return null;
  const inCells = s.cells.filter(c => eCellFace(c, suit)).length;
  const onCols = s.t.filter(col => col.length && eFace(last(col)) && eSuit(last(col)) === suit).length;
  if (inCells + onCols !== 4) return null;
  let target = s.cells.findIndex(c => eCellFace(c, suit));
  if (target < 0) target = s.cells.findIndex(eOpen);
  if (target < 0) return null;
  const cells = s.cells.map(c => (eCellFace(c, suit) ? null : c));
  cells[target] = 'S' + suit;
  const t = s.t.map(col => (col.length && eFace(last(col)) && eSuit(last(col)) === suit ? col.slice(0, -1) : col));
  return { ...s, cells, t };
}

// Moves that can only help, made as soon as they're possible: the star home, a number nothing
// could still need, and collapsing a suit (its faces have nowhere else to end up).
function eForced(s) {
  const moves = [];
  for (;;) {
    let next = null;
    const exposed = [];
    s.cells.forEach((c, i) => { if (typeof c === 'number') exposed.push({ id: c, cell: i }); });
    s.t.forEach((col, c) => { if (col.length) exposed.push({ id: last(col), col: c }); });
    for (const e of exposed) {
      const safe = e.id === E_STAR ||
        (eNumber(e.id) && eRank(e.id) === s.f[eSuit(e.id)] + 1 && s.f.every((n, i) => i === eSuit(e.id) || n >= eRank(e.id) - 1));
      if (!safe) continue;
      const cells = e.cell === undefined ? s.cells : replaced(s.cells, e.cell, null);
      const t = e.col === undefined ? s.t : replaced(s.t, e.col, s.t[e.col].slice(0, -1));
      const f = e.id === E_STAR ? s.f : replaced(s.f, eSuit(e.id), s.f[eSuit(e.id)] + 1);
      next = { ...s, cells, t, f, star: s.star || e.id === E_STAR };
      moves.push({ card: e.id, to: e.id === E_STAR ? { type: 'star', pos: 0 } : { type: 'found', idx: eSuit(e.id) } });
      break;
    }
    if (!next) {
      for (let suit = 0; suit < 3 && !next; suit++) {
        next = eCollapse(s, suit);
        if (next) moves.push({ collapse: suit });
      }
    }
    if (!next) return { state: s, moves };
    s = next;
  }
}

function elementsNext(s) {
  const out = [];
  const push = (state, move) => {
    const forced = eForced(state);
    out.push({ state: forced.state, moves: [move, ...forced.moves] });
  };
  const firstEmpty = s.t.findIndex(col => !col.length);
  const firstCell = s.cells.findIndex(eOpen);

  // Out of a free cell.
  s.cells.forEach((id, i) => {
    if (typeof id !== 'number') return;
    const cells = replaced(s.cells, i, null);
    if (eNumber(id) && eRank(id) === s.f[eSuit(id)] + 1) {
      push({ ...s, cells, f: replaced(s.f, eSuit(id), s.f[eSuit(id)] + 1) }, { card: id, to: { type: 'found', idx: eSuit(id) } });
    }
    for (let d = 0; d < 8; d++) {
      const target = s.t[d];
      if (target.length ? !eFits(id, last(target)) : d !== firstEmpty) continue;
      push({ ...s, cells, t: replaced(s.t, d, target.concat(id)) }, { card: id, to: { type: 'tableau', idx: d } });
    }
  });

  // Out of a column: any part of its movable run, however long.
  for (let c = 0; c < 8; c++) {
    const col = s.t[c];
    if (!col.length) continue;
    const top = last(col);
    if (eNumber(top) && eRank(top) === s.f[eSuit(top)] + 1) {
      push({ ...s, t: replaced(s.t, c, col.slice(0, -1)), f: replaced(s.f, eSuit(top), s.f[eSuit(top)] + 1) }, { card: top, to: { type: 'found', idx: eSuit(top) } });
    }
    for (let i = eRunStart(col); i < col.length; i++) {
      const rest = col.slice(0, i);
      for (let d = 0; d < 8; d++) {
        if (d === c) continue;
        const target = s.t[d];
        if (target.length ? !eFits(col[i], last(target)) : d !== firstEmpty || !rest.length) continue;
        push({ ...s, t: replaced(replaced(s.t, c, rest), d, target.concat(col.slice(i))) }, { card: col[i], to: { type: 'tableau', idx: d } });
      }
    }
    if (firstCell >= 0) {
      push({ ...s, cells: replaced(s.cells, firstCell, top), t: replaced(s.t, c, col.slice(0, -1)) }, { card: top, to: { type: 'cell', idx: firstCell } });
    }
  }
  return out;
}

const elementsRules = {
  next: elementsNext,
  // Face cards of a suit are interchangeable, and so is which cell holds what.
  key: s => {
    const name = id => (typeof id === 'number' && eFace(id) ? 'f' + eSuit(id) : String(id));
    return s.t.map(col => col.map(name).join(',')).sort().join(';') + '|' + s.cells.map(name).sort().join(',') + '|' + s.f.join(',') + (s.star ? '*' : '');
  },
  score: s => {
    const home = s.f[0] + s.f[1] + s.f[2];
    let buried = 0;
    let tangled = 0;
    for (const col of s.t) {
      if (!col.length) continue;
      tangled += eRunStart(col);
      col.forEach((id, i) => {
        if (id === E_STAR || (eNumber(id) && eRank(id) === s.f[eSuit(id)] + 1)) buried += col.length - 1 - i;
      });
    }
    const used = s.cells.filter(c => typeof c === 'number').length;
    const sealed = s.cells.filter(eSealed).length;
    const empties = s.t.filter(col => !col.length).length;
    return 4 * (27 - home) + 2 * buried + 2 * tangled + 2 * used - 8 * sealed - 3 * empties + (s.star ? 0 : 3);
  },
  won: s => s.star && s.f.every(n => n === 9) && s.cells.every(eSealed),
  depthCost: 0.02,
};

function solveElements(deck) {
  const t = Array.from({ length: 8 }, (_, c) => deck.slice(c * 5, c * 5 + 5));
  const start = eForced({ t, cells: [null, null, null], f: [0, 0, 0], star: false });
  const moves = search(start.state, elementsRules);
  return moves && [...start.moves, ...moves];
}

// ---------- By game ----------

const SIZES = { klondike: 52, freecell: 52, clearview: 52, quartet: 36, elements: 40 };

function solve(play, deck) {
  switch (play.game) {
    case 'klondike': return solveKlondike(deck, play.value);
    case 'freecell': return solveFreecell(deck);
    case 'clearview': return solveClearview(deck);
    case 'quartet': return solveQuartet(deck);
    case 'elements': return solveElements(deck);
  }
  throw new Error('No solver for ' + play.game);
}

module.exports = { solve, SIZES };
