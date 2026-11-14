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
    const hinted = hintedTarget(ids);
    if (hinted) return hinted;
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

  // Safe auto-play still has a card to send home, so it's about to move on its own.
  const autoPending = () => G.settings.autoSafe && !!nextFoundationMove(G.state, isSafeHome);

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

  // A hint is a short line of moves that ends with another card going home, shown one move at a
  // time. The line comes from solver.js, which looks for a way to win the whole game, so a hint
  // never leads into a dead end. If the game can't be won any more, the hint first takes the
  // player back, a move at a time, to the last position that still can be.
  //
  // `guide` is the hint on the table, or null. Its phase is 'thinking' (waiting on the solver),
  // 'rewinding', 'steps' (showing steps[index]), 'done' or 'failed'.
  let guide = null;
  let guideTimer = null;
  let known = null; // { autoSafe, startKey, line }: the last winning line, to pick up again later
  let worker;       // the solver's Web Worker, or false where the browser can't run one
  let jobs = 0;
  let rethought = false; // this hint has already had to start over once

  const guideEl = document.createElement('div');
  guideEl.className = 'guide';
  guideEl.setAttribute('role', 'status');
  guideEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(guideEl);
  guideEl.addEventListener('click', e => { if (e.target.closest('[data-guide="close"]')) closeGuide(); });

  const stateKey = () => FreeCellSolver.key(FreeCellSolver.fromGame(G.state));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const tag = id => `<b class="${card(id).color}">${nameOf(id)}</b>`;
  const list = ids => {
    const names = ids.map(tag);
    return names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${last(names)}`;
  };
  const svg = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    spin: '<span class="guide-spin"></span>',
    bulb: svg('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/>'),
    back: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    done: svg('<path d="M5 12.5 10 17.5 19 7"/>'),
    stop: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5v.01"/>'),
  };

  function hint() {
    if (guide) {
      if (guide.phase === 'steps') nudge();
      return;
    }
    if (foundCount() === 52) return;
    guide = { phase: 'thinking' };
    rethought = false;
    // Still on the last line found? Then carry on along it rather than think again.
    const at = resume(stateKey());
    if (at >= 0) {
      startSteps(known.line.slice(at));
      return;
    }
    think();
  }

  function think() {
    guide = { phase: 'thinking' };
    paint({ mode: 'thinking', icon: ICON.spin, meta: 'Hint', text: 'Finding a way forward…' });
    ask();
  }

  function resume(k) {
    if (!known || known.autoSafe !== G.settings.autoSafe) return -1;
    if (k === known.startKey) return 0;
    const i = known.line.findIndex(m => m.key === k);
    return i >= 0 && i + 1 < known.line.length ? i + 1 : -1;
  }

  // ----- Asking the solver -----

  function solverWorker() {
    if (worker === undefined) {
      try {
        worker = new Worker('solver.js?v=1'); // keep in step with index.html's version
        worker.onmessage = e => onPlan(e.data);
        worker.onerror = e => {
          e.preventDefault();
          worker.terminate();
          worker = false;
          if (guide && guide.job) solveHere(guide.job);
        };
      } catch {
        worker = false;
      }
    }
    return worker;
  }

  function ask() {
    const job = {
      id: ++jobs,
      current: G.state,
      history: G.history.map(h => JSON.parse(h)),
      autoSafe: G.settings.autoSafe,
    };
    guide.job = job;
    const w = solverWorker();
    if (w) w.postMessage(job);
    else solveHere(job);
  }

  // No worker: think on the page itself, once the "thinking" panel has had a moment to show.
  function solveHere(job) {
    clearTimeout(guideTimer);
    guideTimer = setTimeout(() => {
      onPlan({ id: job.id, ...FreeCellSolver.plan(job.current, job.history, job.autoSafe) });
    }, 80);
  }

  function onPlan(msg) {
    if (!guide || !guide.job || guide.job.id !== msg.id) return;
    if (msg.rewinding) {
      paint({ mode: 'checking', icon: ICON.spin, meta: 'No way to win from here', text: 'Looking back through your moves…' });
      return;
    }
    guide.job = null;
    if (msg.back === 0) startSteps(msg.line);
    else if (msg.back > 0) rewind(msg.back, msg.line);
    else failed();
  }

  // ----- Going back -----

  // Say what's about to happen, give the player a moment to read it, take the moves back one at
  // a time so they can watch the cards return, then say where that's left them.
  function rewind(back, line) {
    guide.phase = 'rewinding';
    G.busy = true;
    paint({
      mode: 'rewind',
      icon: ICON.back,
      meta: 'No way to win from here<span class="guide-tally"></span>',
      text: `Going back ${plural(back, 'move')} to where you can still win`,
      close: false,
      bar: '<div class="guide-bar"><i></i></div>',
    });
    let done = 0;
    const finish = () => {
      G.busy = false;
      G.updateHud();
      paint({
        mode: 'rewound',
        icon: ICON.back,
        meta: `Went back ${plural(back, 'move')}`,
        text: 'You can still win from here',
        close: false,
        bar: '<div class="guide-bar"><i style="width: 100%"></i></div>',
      });
      guideTimer = setTimeout(() => startSteps(line), 1600);
    };
    const step = () => {
      G.state = JSON.parse(G.history.pop());
      G.committed(true);
      done++;
      guideEl.querySelector('.guide-bar i').style.width = (100 * done / back) + '%';
      guideEl.querySelector('.guide-tally').textContent = `${done} / ${back}`;
      guideTimer = done < back ? setTimeout(step, Solitaire.paced(340, done)) : setTimeout(finish, 600);
    };
    guideTimer = setTimeout(step, 1900);
  }

  function failed() {
    guide.phase = 'failed';
    paint({
      mode: 'failed',
      icon: ICON.stop,
      meta: 'No way to win',
      text: `Not from here, or anywhere earlier in this game. ${G.daily ? 'Restart the deal' : 'Deal a new game'} to try again.`,
    });
    guideTimer = setTimeout(closeGuide, 7000);
  }

  // ----- Showing the steps -----

  // Take `line` up to and including the move that gets the next card home. Count from where the
  // line starts, which may be a card or two further on than the table if auto-play has yet to run.
  function startSteps(line) {
    const end = line.length ? line.findIndex(m => m.home > line[0].home - line[0].sent.length) : -1;
    if (end < 0) {
      closeGuide();
      return;
    }
    known = { autoSafe: G.settings.autoSafe, startKey: stateKey(), line };
    guide = { phase: 'steps', steps: line.slice(0, end + 1), index: 0, sent: line[end].sent, goal: line[end].home, shown: -1 };
    if (autoPending()) G.autoPlay(); // the first step shows once auto-play has sent its cards home
    else showStep();
  }

  // Where a step's card is and where it goes, on the table as it is now.
  function resolve(step) {
    const from = locate(step.card);
    const ids = from && grab(from);
    if (!ids) return null;
    const { tableau } = G.state;
    let to;
    if (step.to.type === 'found') to = { type: 'found', idx: card(step.card).suit };
    else if (step.to.type === 'cell') to = { type: 'cell', idx: G.state.cells.indexOf(null) };
    else if (step.to.onto !== null) to = { type: 'tableau', idx: tableau.findIndex(col => last(col) === step.to.onto) };
    else to = { type: 'tableau', idx: tableau.findIndex((col, c) => !col.length && !(from.type === 'tableau' && from.idx === c)) };
    return to.idx >= 0 && canDrop(ids, from, to) ? { from, ids, to } : null;
  }

  // Did the player just make this step's move? Any free cell or empty column will do.
  function matches(step, ids, to) {
    if (ids[0] !== step.card || to.type !== step.to.type) return false;
    if (to.type !== 'tableau') return true;
    const col = G.state.tableau[to.idx];
    return step.to.onto === null ? !col.length : last(col) === step.to.onto;
  }

  function stepText(step, r) {
    const n = r.ids.length;
    const what = tag(step.card) + (n > 1 ? ` and the ${n - 1} below it` : '');
    let where;
    if (step.to.type === 'found') where = 'to its foundation';
    else if (step.to.type === 'cell') where = 'into a free cell';
    else where = step.to.onto === null ? 'into an empty column' : `onto ${tag(step.to.onto)}`;
    return `Move ${what} ${where}`;
  }

  // Light up the current step. Called after every render, so it follows the cards around; it
  // waits while auto-play is still sending cards home.
  function showStep() {
    if (!guide || guide.phase !== 'steps' || autoPending()) return;
    const step = guide.steps[guide.index];
    const r = resolve(step);
    if (!r) {
      // The table doesn't match the line, which shouldn't happen. Work it out afresh, once.
      unlight();
      known = null;
      if (rethought) closeGuide();
      else {
        rethought = true;
        think();
      }
      return;
    }
    const fresh = guide.shown !== guide.index;
    guide.shown = guide.index;
    if (fresh) {
      const segs = guide.steps.map((_, i) => `<i class="${i < guide.index ? 'past' : i === guide.index ? 'now' : ''}"></i>`).join('');
      paint({
        mode: 'steps',
        icon: ICON.bulb,
        meta: `Move <span class="guide-num">${guide.index + 1}</span> of ${guide.steps.length} · to get ${list(guide.sent)} home`,
        text: stepText(step, r),
        bar: `<div class="guide-bar steps" aria-hidden="true">${segs}</div>`,
      });
    }
    light(r, fresh);
  }

  function light(r, pop) {
    unlight();
    const els = r.ids.map(id => G.els[id]);
    els.forEach(el => {
      el.classList.add('hint');
      if (pop) popCard(el);
    });
    targetEl(r.to).classList.add('hint-target');
  }

  function unlight() {
    G.board.querySelectorAll('.hint, .hint-target').forEach(el => el.classList.remove('hint', 'hint-target'));
  }

  function popCard(el) {
    el.classList.remove('hint-pop');
    void el.offsetWidth;
    el.classList.add('hint-pop');
    clearTimeout(el._hp);
    el._hp = setTimeout(() => el.classList.remove('hint-pop'), 600);
  }

  function nudge() {
    guideEl.classList.remove('nudge');
    void guideEl.offsetWidth;
    guideEl.classList.add('nudge');
    G.board.querySelectorAll('.card.hint').forEach(popCard);
  }

  function finishGuide() {
    if (guide.goal >= 52) {
      closeGuide(); // the win takes it from here
      return;
    }
    guide.phase = 'done';
    unlight();
    paint({
      mode: 'done',
      icon: ICON.done,
      meta: 'Done · press Hint for the next one',
      text: `${list(guide.sent)} ${guide.sent.length > 1 ? 'are' : 'is'} home`,
    });
    clearTimeout(guideTimer);
    guideTimer = setTimeout(closeGuide, 2600);
  }

  // ----- The panel -----

  // The panel lives in the header, over the title and the stats, so it never hides a card or a
  // button. `meta` is the small line on top, `text` the instruction, `bar` a strip along the foot.
  function paint({ mode, icon, meta, text, close = true, bar = '' }) {
    guideEl.dataset.mode = mode;
    guideEl.innerHTML = `
      <span class="guide-icon">${icon}</span>
      <div class="guide-body">
        <div class="guide-meta">${meta}</div>
        <div class="guide-text">${text}</div>
      </div>
      ${close ? '<button class="guide-x" data-guide="close" aria-label="Close hint" title="Close hint (Esc)">✕</button>' : ''}
      ${bar}`;
    dock();
    if (!guideEl.classList.contains('show')) {
      guideEl.classList.remove('nudge');
      void guideEl.offsetWidth;
      guideEl.classList.add('show');
    }
  }

  // Cover the stretch of the header beside the buttons: the stats, and the title too when
  // that's what it takes to fit (on phones the buttons have a row to themselves).
  function dock() {
    const hud = $('#hud');
    const box = hud.getBoundingClientRect();
    const [brand, stats, actions] = ['.brand', '.stats', '.actions'].map(sel => hud.querySelector(sel).getBoundingClientRect());
    const sameRow = (a, b) => a.top < b.bottom - 4 && b.top < a.bottom - 4;
    let left = box.left + 10;
    let right = box.right - 10;
    if (sameRow(stats, actions)) right = Math.min(right, actions.left - 14);
    const overBrand = !(sameRow(stats, brand) && right - brand.right - 14 >= 300);
    if (!overBrand) left = brand.right + 14;
    hud.classList.add('guide-on');
    hud.classList.toggle('guide-over-brand', overBrand);
    const width = Math.min(480, right - left);
    guideEl.style.width = width + 'px';
    guideEl.style.left = Math.round(left + (right - left - width) / 2) + 'px';
    guideEl.style.top = Math.max(4, Math.round(stats.top + stats.height / 2 - guideEl.offsetHeight / 2)) + 'px';
  }
  window.addEventListener('resize', () => { if (guide) dock(); });

  function closeGuide() {
    if (!guide) return;
    if (guide.phase === 'rewinding') {
      G.busy = false;
      G.updateHud();
    }
    // A worker still thinking about a hint nobody wants is stopped; a fresh one starts next time.
    if (guide.job && worker) {
      worker.terminate();
      worker = undefined;
    }
    clearTimeout(guideTimer);
    guide = null;
    unlight();
    guideEl.classList.remove('show');
    $('#hud').classList.remove('guide-on');
  }

  // ----- Following along -----

  // The player is making a move: if it's the step the hint asked for, the hint moves on;
  // anything else puts it away.
  function moved(from, ids, to) {
    if (!guide || guide.phase === 'done') return;
    if (guide.phase === 'steps' && matches(guide.steps[guide.index], ids, to)) {
      guide.index++;
      if (guide.index === guide.steps.length) finishGuide();
      return;
    }
    closeGuide();
  }

  // Tapping the hinted card sends it where the hint says.
  function hintedTarget(ids) {
    if (!guide || guide.phase !== 'steps' || guide.steps[guide.index].card !== ids[0]) return null;
    const r = resolve(guide.steps[guide.index]);
    return r && r.to;
  }

  function targetEl(to) {
    const pile = pileOf(to);
    if (pile.length) return G.els[last(pile)];
    if (to.type === 'cell') return G.slots.cells[to.idx];
    return to.type === 'found' ? G.slots.found[to.idx] : G.slots.tab[to.idx];
  }

  // ---------- Layout & rendering ----------

  const colX = c => c * (G.L.cw + G.L.gap);

  // Where spot k of the top row sits: the four free cells, then the four foundations. With two
  // rows the cells sit above the foundations.
  const topPos = k => ({ x: colX(k % G.L.per), y: G.L.top + Math.floor(k / G.L.per) * (G.L.ch + G.L.gap) });
  const cellPos = i => topPos(i);
  const foundPos = f => topPos(CELLS + f);

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
      Math.floor(Math.max(34, Math.min(availW / (per + (per - 1) * gapR), 120, availH / 1.4 / tall)));
    let per = COLS;
    let cw = fit(COLS, 3.9);
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
    slots.cells.forEach((el, i) => place(el, cellPos(i).x, cellPos(i).y));
    slots.found.forEach((el, f) => place(el, foundPos(f).x, foundPos(f).y));
    slots.tab.forEach((el, c) => place(el, colPos(c).x, colPos(c).y));
  }

  function positions() {
    const state = G.state;
    const out = {};
    const { ch } = G.L;

    state.cells.forEach((id, i) => {
      if (id !== null) out[id] = { ...cellPos(i), z: 100, down: false, key: 'c' + i };
    });

    state.foundations.forEach((f, fi) => {
      f.forEach((id, i) => {
        out[id] = { ...foundPos(fi), z: 200 + i, down: false, key: 'f' + fi };
      });
    });

    // Long columns squeeze their fan to fit the table. Buried cards are shaded, except the next
    // card each foundation needs, so it's easy to spot what to dig out.
    state.tableau.forEach((col, c) => {
      const { x, y, room } = colPos(c);
      let off = ch * 0.27;
      if (col.length > 1) off = Math.max(ch * 0.1, Math.min(off, room / (col.length - 1)));
      let runStart = col.length - 1;
      while (runStart > 0 && fits(col[runStart], col[runStart - 1])) runStart--;
      col.forEach((id, i) => {
        out[id] = { x, y: Math.round(y + i * off), z: 400 + i, down: false, key: 't' + c, locked: i < runStart && !canFound(id, state) };
      });
    });
    return out;
  }

  function dropZones() {
    const { L, P, state } = G;
    const zones = state.tableau.map((col, c) => ({
      to: { type: 'tableau', idx: c },
      x: colPos(c).x, y: col.length ? P[last(col)].y : colPos(c).y, w: L.cw, h: L.ch * 1.5,
    }));
    for (let i = 0; i < CELLS; i++) zones.push({ to: { type: 'cell', idx: i }, ...cellPos(i), w: L.cw, h: L.ch });
    for (let f = 0; f < 4; f++) zones.push({ to: { type: 'found', idx: f }, ...foundPos(f), w: L.cw, h: L.ch });
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
    $('#btn-auto').classList.toggle('hidden', G.busy || autoPending() || !canAutoFinish());
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
    </ul>
    <h3>Hints</h3>
    <ul>
      <li>A hint lays out the moves that get another card home, one at a time, counting them off as you play them. Make a different move, or press <kbd>Esc</kbd>, to put it away.</li>
      <li>Hints follow a way to win the whole game. If the game can't be won any more, the hint first takes you back to the last point where it still could.</li>
    </ul>`;

  const settingsHTML = () => `
    <label class="toggle">
      <input type="checkbox" data-setting="autoSafe"${G.settings.autoSafe ? ' checked' : ''}>
      <span class="switch" aria-hidden="true"></span>
      <span><b>Auto-play safe cards</b><small>Sends a card home automatically once nothing could still need it in the columns. This never turns a winnable game into a lost one.</small></span>
    </label>
    <label class="toggle">
      <input type="checkbox" data-setting="twoRows"${G.settings.twoRows ? ' checked' : ''}>
      <span class="switch" aria-hidden="true"></span>
      <span><b>Two-row layout</b><small>On tall, narrow screens like phones, splits the eight columns into two rows of four, with the free cells above the foundations, so the cards can be bigger. Wide screens keep a single row.</small></span>
    </label>`;

  function onSetting(key) {
    if (key === 'autoSafe') {
      closeGuide(); // its line was worked out with the old setting
      known = null;
    }
    if (key === 'twoRows') {
      G.layout();
      if (!G.meta.won) G.render();
      return;
    }
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
    hint,
    moved,
    undone: closeGuide,
    dealt: () => {
      closeGuide();
      known = null;
    },
    afterRender: showStep,
    onKey: key => { if (key === 'escape' && guide && guide.phase !== 'rewinding') closeGuide(); },
    dealOrder,
    dealFrom: () => ({ x: Math.round((G.L.w - G.L.cw) / 2), y: G.L.top, key: 'deal' }),
    nextAuto,
    updateHud,
    wire: () => $('#btn-auto').addEventListener('click', autoFinish),
    rulesHTML,
    settingsDefaults: { autoSafe: true, twoRows: false },
    settingsHTML,
    onSetting,
  });

  G.start();
})();
