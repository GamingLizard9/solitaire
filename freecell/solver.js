// FreeCell's hint solver: looks for a way to win from a position, playing the same moves a player
// can (whole runs at once, as far as the free cells and empty columns allow). game.js runs it in a
// Web Worker so the table never freezes while it thinks; the page loads it too, as a fallback for
// browsers without workers. tools/ can require() it for testing.
//
// A move is { card, to }: pick up `card` with whatever sits on it and put it `to`
// { type: 'found' }, { type: 'cell' } or { type: 'tableau', onto } (onto: the card it lands on,
// or null for an empty column). Moves name cards rather than places, so a line stays good
// whichever free cell or empty column the player happens to use.
(() => {
  'use strict';

  const BUDGET = 60000; // positions to look at before giving up on one position

  const suit = id => (id / 13) | 0;
  const rank = id => id % 13 + 1;
  const red = id => suit(id) % 2 === 1;
  const fits = (lower, upper) => rank(upper) === rank(lower) + 1 && red(upper) !== red(lower);
  const last = a => a[a.length - 1];
  const homeCount = f => f[0] + f[1] + f[2] + f[3];
  const canHome = (id, f) => rank(id) === f[suit(id)] + 1;

  // The game's safe auto-play test (isSafeHome in game.js): nothing could still need this card.
  function safeHome(id, f) {
    const r = rank(id);
    const s = suit(id);
    if (r !== f[s] + 1) return false;
    const opp = Math.min(f[(s + 1) % 4], f[(s + 3) % 4]);
    const twin = f[(s + 2) % 4];
    return opp >= r - 1 || (opp >= r - 2 && twin >= r - 3);
  }

  const runStart = col => {
    let i = col.length - 1;
    while (i > 0 && fits(col[i], col[i - 1])) i--;
    return i;
  };

  // game.js's state ({ cells, foundations, tableau }) in the solver's form.
  const fromGame = g => ({ t: g.tableau.map(col => col.slice()), cells: g.cells.slice(), f: g.foundations.map(p => p.length) });

  const key = s => s.t.map(col => col.join(',')).sort().join(';') + '|' +
    s.cells.filter(id => id !== null).sort((a, b) => a - b).join(',') + '|' + s.f.join(',');

  const won = s => homeCount(s.f) === 52;

  function copy(s) {
    return { t: s.t.slice(), cells: s.cells.slice(), f: s.f.slice() };
  }

  // Send every safe card home, the way the game's auto-play does after each move.
  function settle(s) {
    for (let again = true; again;) {
      again = false;
      for (let i = 0; i < 4; i++) {
        const id = s.cells[i];
        if (id !== null && safeHome(id, s.f)) {
          s.cells[i] = null;
          s.f[suit(id)]++;
          again = true;
        }
      }
      for (let c = 0; c < 8; c++) {
        const col = s.t[c];
        if (col.length && safeHome(last(col), s.f)) {
          s.t[c] = col.slice(0, -1);
          s.f[suit(last(col))]++;
          again = true;
        }
      }
    }
    return s;
  }

  // How many cards can move as one run (capacity() in game.js).
  function capacity(s, toEmpty) {
    let cells = 0;
    let empties = toEmpty ? -1 : 0;
    for (const id of s.cells) if (id === null) cells++;
    for (const col of s.t) if (!col.length) empties++;
    return (cells + 1) * 2 ** Math.max(0, empties);
  }

  // Play `m` on `s`, returning the new state, or null if it isn't legal there.
  function apply(s, m, autoSafe) {
    const out = copy(s);
    let ids;
    const cell = s.cells.indexOf(m.card);
    if (cell >= 0) {
      ids = [m.card];
      out.cells[cell] = null;
    } else {
      const c = s.t.findIndex(col => col.includes(m.card));
      if (c < 0) return null;
      const col = s.t[c];
      const i = col.indexOf(m.card);
      for (let j = i + 1; j < col.length; j++) if (!fits(col[j], col[j - 1])) return null;
      ids = col.slice(i);
      out.t[c] = col.slice(0, i);
    }
    // The target is found on the table as it was, so a move never lands back where it started
    // (the game refuses those, and tidy() could otherwise leave one behind).
    const to = m.to;
    if (to.type === 'found') {
      if (ids.length !== 1 || !canHome(m.card, s.f)) return null;
      out.f[suit(m.card)]++;
    } else if (to.type === 'cell') {
      const free = s.cells.indexOf(null);
      if (ids.length !== 1 || free < 0 || cell >= 0) return null;
      out.cells[free] = m.card;
    } else {
      const d = to.onto === null ? s.t.findIndex(col => !col.length) : s.t.findIndex(col => last(col) === to.onto);
      if (d < 0) return null;
      if (to.onto !== null && !fits(m.card, to.onto)) return null;
      if (ids.length > capacity(s, to.onto === null)) return null;
      out.t[d] = out.t[d].concat(ids);
    }
    return autoSafe ? settle(out) : out;
  }

  function nextMoves(s, autoSafe) {
    const out = [];
    const add = (card, to) => {
      const state = apply(s, { card, to }, autoSafe);
      if (state) out.push({ move: { card, to }, state });
    };
    const home = { type: 'found' };

    // Without auto-play, a safe card going home is still always right.
    if (!autoSafe) {
      for (const id of s.cells) if (id !== null && safeHome(id, s.f)) { add(id, home); return out; }
      for (const col of s.t) if (col.length && safeHome(last(col), s.f)) { add(last(col), home); return out; }
    }

    const tops = s.t.map(col => (col.length ? last(col) : null));
    const anyEmpty = tops.includes(null);
    const anyCell = s.cells.includes(null);

    for (const id of s.cells) {
      if (id === null) continue;
      if (canHome(id, s.f)) add(id, home);
      for (const top of tops) if (top !== null && fits(id, top)) add(id, { type: 'tableau', onto: top });
      if (anyEmpty) add(id, { type: 'tableau', onto: null });
    }

    for (let c = 0; c < 8; c++) {
      const col = s.t[c];
      if (!col.length) continue;
      const top = last(col);
      if (canHome(top, s.f)) add(top, home);
      const rs = runStart(col);
      for (let i = rs; i < col.length; i++) {
        // Splitting a run off a card it already sits on only helps if that card can then go home.
        if (i > rs && !canHome(col[i - 1], s.f)) continue;
        const base = col[i];
        for (let d = 0; d < 8; d++) {
          if (d !== c && tops[d] !== null && fits(base, tops[d])) add(base, { type: 'tableau', onto: tops[d] });
        }
        if (anyEmpty && i > 0) add(base, { type: 'tableau', onto: null });
      }
      if (anyCell) add(top, { type: 'cell' });
    }
    return out;
  }

  function score(s) {
    let held = 0;
    let empties = 0;
    let tangled = 0;
    let dig = 0;
    for (const id of s.cells) if (id !== null) held++;
    for (const col of s.t) {
      if (!col.length) { empties++; continue; }
      tangled += runStart(col);
      for (let i = 0; i < col.length; i++) if (canHome(col[i], s.f)) dig += col.length - 1 - i;
    }
    return 4 * (52 - homeCount(s.f)) + 2 * dig + tangled + 3 * held - 4 * empties;
  }

  // Binary heap of [priority, order, node]; ties go to the newest, which keeps the search digging.
  class Heap {
    constructor() { this.a = []; }
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

  // Best-first search for a win. Returns the moves, or null if there is none, or `false` if none
  // turned up within the budget (so there may still be one).
  function search(start, autoSafe, budget) {
    const heap = new Heap();
    const seen = new Set([key(start)]);
    let order = 0;
    heap.push([score(start), order++, { state: start, parent: null, move: null, depth: 0 }]);
    for (let looked = 0; heap.size; looked++) {
      if (looked >= budget) return false;
      const node = heap.pop()[2];
      if (won(node.state)) {
        const moves = [];
        for (let n = node; n.parent; n = n.parent) moves.push(n.move);
        return moves.reverse();
      }
      for (const { move, state } of nextMoves(node.state, autoSafe)) {
        const k = key(state);
        if (seen.has(k)) continue;
        seen.add(k);
        const depth = node.depth + 1;
        heap.push([score(state) + depth * 0.05, order++, { state, parent: node, move, depth }]);
      }
    }
    return null;
  }

  // Replay `moves` from `start`: each move with the number of cards home after it, the cards it
  // sent home (auto-play included) and the key of the position it leads to. Null if a move
  // doesn't play.
  function replay(start, moves, autoSafe) {
    let s = start;
    const out = [];
    for (const move of moves) {
      const before = s.f;
      s = apply(s, move, autoSafe);
      if (!s) return null;
      const sent = [];
      for (let su = 0; su < 4; su++) for (let r = before[su] + 1; r <= s.f[su]; r++) sent.push(su * 13 + r - 1);
      out.push({ ...move, home: homeCount(s.f), sent, key: key(s) });
    }
    return out;
  }

  // Search lines can wander. Drop any move whose removal still reaches the same position at each
  // point a card goes home, so the hint only asks for moves that matter.
  function tidy(start, moves, autoSafe) {
    const marks = line => {
      const r = replay(start, line, autoSafe);
      if (!r) return null;
      const out = [];
      let home = homeCount(start.f);
      for (const step of r) if (step.home > home) { out.push(step.key); home = step.home; }
      return out.join(' ');
    };
    const goal = marks(moves);
    let line = moves;
    for (let i = line.length - 1; i >= 0; i--) {
      if (line[i].to.type === 'found') continue;
      const without = line.slice(0, i).concat(line.slice(i + 1));
      if (marks(without) === goal) line = without;
    }
    return line;
  }

  // A hint shows the moves up to the next card home, so that stretch should be as short as it can
  // be. Look breadth-first for a quicker way to get a card home that still leaves a win, and if
  // there is one, take it, with a fresh win from there.
  const QUICK_NODES = 20000; // positions to look through for a quicker way
  const QUICK_TRIES = 40;    // of those that get a card home, how many to check can still be won

  function quicken(start, moves, autoSafe) {
    const home = homeCount(start.f);
    let s = start;
    let len = 0;
    for (const m of moves) {
      s = apply(s, m, autoSafe);
      len++;
      if (homeCount(s.f) > home) break;
    }
    if (len <= 2) return moves;
    const seen = new Set([key(start)]);
    let layer = [{ state: start, path: [] }];
    let nodes = 0;
    let tries = 0;
    for (let depth = 1; depth < len; depth++) {
      const next = [];
      for (const { state, path } of layer) {
        for (const { move, state: after } of nextMoves(state, autoSafe)) {
          const k = key(after);
          if (seen.has(k)) continue;
          seen.add(k);
          const p = path.concat([move]);
          if (homeCount(after.f) > home) {
            if (++tries > QUICK_TRIES) return moves;
            const rest = search(after, autoSafe, BUDGET / 4);
            if (rest) return p.concat(rest);
          } else {
            if (++nodes > QUICK_NODES) return moves;
            next.push({ state: after, path: p });
          }
        }
      }
      layer = next;
    }
    return moves;
  }

  // A winning line from game state `g`, as replay() gives it, or null if none was found. Most
  // positions are settled one way or the other well within BUDGET; a hard one gets a longer look
  // before it's written off, since writing it off sends the player back.
  function solve(g, autoSafe, budget = BUDGET) {
    let start = fromGame(g);
    if (autoSafe) start = settle(start);
    if (won(start)) return [];
    let moves = search(start, autoSafe, budget);
    if (moves === false) moves = search(start, autoSafe, budget * 6);
    if (!moves) return null;
    moves = tidy(start, moves, autoSafe);
    const quick = quicken(start, moves, autoSafe);
    if (quick !== moves) moves = tidy(start, quick, autoSafe);
    return replay(start, moves, autoSafe);
  }

  // The hint's whole job: a winning line from `current`, or, failing that, from the latest of
  // `history` (oldest first) that has one. `back` is how many positions back that was: 0 for
  // `current`, -1 if none had one. A position that can be won could only have come from ones
  // that can, so it gallops back and then narrows down rather than trying every one.
  function plan(current, history, autoSafe, progress = () => {}) {
    const line = solve(current, autoSafe);
    if (line) return { back: 0, line };
    progress();
    const n = history.length;
    const tried = new Map();
    const at = k => {
      if (!tried.has(k)) tried.set(k, solve(history[k], autoSafe));
      return tried.get(k);
    };
    let bad = n; // known to have no line
    let good = -1;
    for (let step = 1; ; step *= 2) {
      const k = Math.max(0, n - step);
      if (at(k)) { good = k; break; }
      bad = k;
      if (k === 0) break;
    }
    if (good < 0) return { back: -1, line: null };
    while (bad - good > 1) {
      const mid = (good + bad) >> 1;
      if (at(mid)) good = mid;
      else bad = mid;
    }
    return { back: n - good, line: at(good) };
  }

  const api = { solve, plan, key, fromGame };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (typeof window === 'undefined' && typeof self === 'object' && typeof importScripts === 'function') {
    // Running as the hint's worker: game.js posts { id, current, history, autoSafe }.
    self.onmessage = e => {
      const { id, current, history, autoSafe } = e.data;
      const result = plan(current, history, autoSafe, () => self.postMessage({ id, rewinding: true }));
      self.postMessage({ id, ...result });
    };
  } else {
    window.FreeCellSolver = api;
  }
})();
