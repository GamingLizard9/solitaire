// Shared table engine for every game on the site. It owns everything that works the same way
// from game to game: state and undo history, saving, the clock and stats, rendering cards and
// turning them over, drag-and-drop and tap-to-move, hints, toasts, modals and the win sequence.
// A game describes its deck, layout and rules in the definition it passes to createGame().
window.Solitaire = (() => {
  'use strict';

  // ---------- Card data ----------

  const SUITS = [
    { sym: '♠', color: 'black', name: 'Spades' },
    { sym: '♥', color: 'red', name: 'Hearts' },
    { sym: '♣', color: 'black', name: 'Clubs' },
    { sym: '♦', color: 'red', name: 'Diamonds' },
  ];
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

  // ---------- Small helpers ----------

  const last = arr => arr[arr.length - 1];
  const same = (a, b) => a.type === b.type && a.idx === b.idx;
  const place = (el, x, y) => { el.style.transform = `translate(${x}px, ${y}px)`; };

  // A daily deal swaps in its own source of randomness while its cards are shuffled.
  let random = Math.random;
  const shuffle = a => Daily.shuffle(a, random);

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

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  const AUTO_STEP = 140; // default ms between automatic steps
  const FLIP_MS = 500;   // how long a card takes to turn over (see .card.flip3d in table.css)
  const FLIP_LOOKS_DONE = 200; // a flip has eased most of the way round by now (a step's `flipLead` overrides it)
  // ms between the steps of a move played out card by card: slow enough to follow, but a long
  // run speeds up so the whole move takes about STEP_TOTAL.
  const STEP_MIN = 90;
  const STEP_MAX = 230;
  const STEP_TOTAL = 2400;
  // A long chain of automatic moves speeds up as it goes, so the end of a game doesn't drag:
  // each step's pause is PACE_DECAY times the last one's, down to PACE_MIN of the full pause.
  const PACE_DECAY = 0.9;
  const PACE_MIN = 0.3;
  const paced = (ms, n) => Math.round(ms * Math.max(PACE_MIN, PACE_DECAY ** n));

  // ---------- The game runner ----------

  // `game` supplies:
  //   id                       storage prefix
  //   cards                    [{ id, color, ... }], indexed by id
  //   cardLabel(c), faceHTML(c), backHTML?(c)
  //   buildSlots()             create the empty spots with G.makeSlot()
  //   layout(availW, availH)   set G.L ({ cw, ch, w, h, ... }) and place the slots
  //   positions()              card id -> { x, y, z, down, key, locked }
  //   freshState(), validState(s), isWon(), winOrder(), winText
  //   locate(id), grab(loc), canDrop(ids, from, to), apply(s, from, ids, to)
  //   dropZones()              [{ to, x, y, w, h }] for drag-and-drop
  //   targetEl(to), clickTarget(from, ids)
  //   findHints(), describe(hint)   hints carry { ids, to } and/or { el }; or instead
  //   hint()                   run the whole hint itself (the Hint button and H key call it)
  //   dealOrder(), dealFrom()  { x, y, key }
  //   rulesHTML()
  // and optionally: nextAuto() returning a step function, autoStep, afterDealWait,
  //   press(id, loc), afterRender(), updateHud(), onKey(key, e), wire(),
  //   moved(from, ids, to)     the player is making this move (called before it's played),
  //   undone(), dealt()        the player took a move back, or a new deal began,
  //   moveSteps(from, ids, to) [{ from, ids, to }]: a move to play out as these smaller moves,
  //                            in order, so the player can see how it's done,
  //   settingsDefaults, settingsHTML(), onSetting(key), maxWidth,
  //   shading: false           for a game that never shades buried cards, to leave out the
  //                            shared "Shade buried cards" setting,
  //   dealOptions              { key, title, prompt, choices: [{ value, label, sub, icon? }] }: a
  //                            choice asked once on the first visit, then changed in Settings;
  //                            kept in G.settings[key] and read by freshState() at each deal.
  function createGame(game) {
    const $ = sel => document.querySelector(sel);
    const board = $('#board');
    const hud = $('#hud');
    const modal = $('#modal');
    const daily = Daily.forPage(game.id); // the daily deal this page was opened for, if any
    const KEYS = {
      game: daily ? Daily.saveKey(daily) : `${game.id}.game.v1`,
      stats: `${game.id}.stats.v1`,
      settings: `${game.id}.settings.v1`,
    };
    const autoStep = game.autoStep || AUTO_STEP;

    const G = {
      state: null,   // the game's own state; always carries `moves`
      history: [],   // JSON snapshots of previous states, for undo
      meta: null,    // { counted, won, elapsed } — per-game bookkeeping that undo doesn't touch
      stats: null,   // { wins, played, best }
      settings: null,
      daily,
      L: {},         // layout metrics
      P: {},         // card id -> position
      els: [],
      slots: {},
      board,
      busy: false,
    };

    let drag = null;
    let hintTimer = null;
    let hintIndex = 0;
    let dropEl = null;
    let winTimers = [];
    let autoTimer = null;
    let cueTimer = null;
    let cued = [];       // elements lit up for the coming automatic step
    let autoRun = 0;     // automatic steps made since the player last moved
    let mustChoose = false;  // the first-visit deal picker is up and can't be dismissed
    let onChosen = null;
    const clock = { acc: 0, since: null };

    // ---------- Storage ----------

    function save() {
      G.meta.elapsed = elapsed();
      // A finished daily is over for good, and archive deals shouldn't pile up in storage.
      if (daily && G.meta.won) {
        try { localStorage.removeItem(KEYS.game); } catch { /* storage unavailable */ }
        return;
      }
      store(KEYS.game, { state: G.state, history: G.history.slice(-300), meta: G.meta });
    }

    // Shuffle with the daily deal's own randomness when there is one, so it always comes out the same.
    function freshState() {
      if (daily) random = daily.random();
      const state = game.freshState();
      random = Math.random;
      return state;
    }

    const saveStats = () => store(KEYS.stats, G.stats);
    const saveSettings = () => store(KEYS.settings, G.settings);

    // ---------- Actions ----------

    function snapshot() {
      G.history.push(JSON.stringify(G.state));
      if (G.history.length > 400) G.history.shift();
    }

    function move(from, ids, to) {
      if (game.moved) game.moved(from, ids, to);
      snapshot();
      const steps = game.moveSteps && game.moveSteps(from, ids, to);
      if (steps && steps.length > 1) {
        playSteps(steps);
        return;
      }
      game.apply(G.state, from, ids, to);
      G.state.moves++;
      committed();
    }

    // Play a move out as the smaller moves it's made of, one after another. Together they count
    // as a single move with a single undo.
    function playSteps(steps) {
      G.busy = true;
      clearHint();
      const wait = Math.max(STEP_MIN, Math.min(STEP_MAX, STEP_TOTAL / steps.length));
      const next = k => {
        const { from, ids, to } = steps[k];
        game.apply(G.state, from, ids, to);
        if (k < steps.length - 1) {
          render();
          setTimeout(() => next(k + 1), wait);
          return;
        }
        G.busy = false;
        G.state.moves++;
        committed();
      };
      next(0);
    }

    function undo() {
      if (G.busy || G.meta.won) return;
      if (!G.history.length) {
        toast('Nothing to undo');
        return;
      }
      G.state = JSON.parse(G.history.pop());
      if (game.undone) game.undone();
      committed(true);
    }

    // `auto` marks an automatic step: it rides on the previous move's undo snapshot and isn't
    // counted, so one Undo takes back a move together with whatever followed from it.
    function committed(isUndo = false, auto = false, autoWait = autoStep) {
      hintIndex = 0;
      clearHint();
      if (!auto) autoRun = 0;
      if (!isUndo && !auto) {
        if (!G.meta.counted) {
          G.meta.counted = true;
          G.stats.played++;
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
      const to = game.clickTarget(from, ids);
      if (to) move(from, ids, to);
      else shake(ids);
    }

    // ---------- Automatic steps ----------

    // game.nextAuto() returns a function that makes the next automatic step, or null. The
    // function may carry { ids, to, cue }: then those cards glow with their destination for `cue`
    // ms before they go, and hop on the way there, so the player can see what's moving on its
    // own. A card that's turning over starts glowing once the flip looks nearly done; it lifts
    // when the flip ends (table.css), and never leaves before then. The pause and the glow
    // shorten as a chain of automatic steps goes on (see PACE_DECAY); a flip still runs its course.
    function autoPlay(wait = autoStep) {
      if (!game.nextAuto || G.busy || G.meta.won || autoTimer) return;
      const next = game.nextAuto();
      if (!next) return;
      G.busy = true;
      if (next.cue) {
        const flipping = next.ids.some(id => G.els[id].classList.contains('flip3d'));
        const lead = flipping ? Math.min(next.flipLead ?? FLIP_LOOKS_DONE, FLIP_MS) : 0;
        cueTimer = setTimeout(() => { cueTimer = null; showCue(next); }, lead);
        wait = Math.max(lead + paced(next.cue, autoRun), flipping ? FLIP_MS : 0);
      } else {
        wait = paced(wait, autoRun);
      }
      autoTimer = setTimeout(() => {
        autoTimer = null;
        G.busy = false;
        clearCue();
        const step = !G.meta.won && game.nextAuto();
        if (!step) return;
        step();
        autoRun++;
        committed(false, true); // chains into the next step, if any
        if (step.cue) step.ids.forEach(id => hop(G.els[id]));
      }, wait);
    }

    function showCue(step) {
      cued = step.ids.map(id => G.els[id]).concat(game.targetEl(step.to));
      step.ids.forEach(id => G.els[id].classList.add('auto-cue'));
      game.targetEl(step.to).classList.add('auto-target');
    }

    function clearCue() {
      clearTimeout(cueTimer);
      cueTimer = null;
      cued.forEach(el => el.classList.remove('auto-cue', 'auto-target'));
      cued = [];
    }

    function hop(el) {
      el.classList.remove('auto-fly');
      void el.offsetWidth;
      el.classList.add('auto-fly');
      clearTimeout(el._ht);
      el._ht = setTimeout(() => el.classList.remove('auto-fly'), 600);
    }

    function stopAutoPlay() {
      clearCue();
      if (!autoTimer) return;
      clearTimeout(autoTimer);
      autoTimer = null;
      G.busy = false;
    }

    // ---------- Hints ----------

    function showHint() {
      if (G.busy || G.meta.won) return;
      if (game.hint) {
        game.hint();
        return;
      }
      clearHint();
      const hints = game.findHints();
      if (!hints.length) {
        toast(`No moves left — try Undo or ${daily ? 'restart the deal' : 'deal a new game'}`);
        return;
      }
      const h = hints[hintIndex % hints.length];
      hintIndex++;
      if (h.el) h.el.classList.add('hint');
      if (h.ids) h.ids.forEach(id => G.els[id].classList.add('hint'));
      if (h.to) game.targetEl(h.to).classList.add('hint-target');
      toast(game.describe(h) + (hints.length > 1 ? '  ·  press again for another' : ''));
      hintTimer = setTimeout(clearHint, 2600);
    }

    function clearHint() {
      clearTimeout(hintTimer);
      board.querySelectorAll('.hint, .hint-target').forEach(el => el.classList.remove('hint', 'hint-target'));
    }

    // ---------- Layout & rendering ----------

    function layout() {
      const hudH = hud.getBoundingClientRect().height;
      // Measure the body rather than the window so phone safe-area padding is respected.
      // Leave room for the table's side padding, which shrinks on small screens.
      const ts = getComputedStyle(board.parentElement);
      const sidePad = parseFloat(ts.paddingLeft) + parseFloat(ts.paddingRight);
      const availW = Math.min(document.body.clientWidth - sidePad, game.maxWidth || 1180);
      const availH = document.body.clientHeight - hudH - 12;
      game.layout(availW, availH);
      board.style.width = G.L.w + 'px';
      board.style.height = G.L.h + 'px';
      board.style.setProperty('--cw', G.L.cw + 'px');
      board.style.setProperty('--ch', G.L.ch + 'px');
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
      G.P = game.positions();
      if (instant) board.classList.add('no-anim');
      const flips = [];
      for (const c of game.cards) {
        const el = G.els[c.id];
        const p = G.P[c.id];
        const delay = stagger ? (stagger[c.id] || 0) : 0;
        el.style.transitionDelay = el.firstChild.style.transitionDelay = delay ? delay + 'ms' : '';
        el.style.transform = `translate(${p.x}px, ${p.y}px)`;
        if (instant || el.classList.contains('down') === p.down) el.classList.toggle('down', p.down);
        else flips.push({ el, down: p.down, delay });
        el.classList.toggle('locked', !!p.locked && shading());
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
      if (game.afterRender) game.afterRender();

      if (instant) {
        void board.offsetWidth;
        board.classList.remove('no-anim');
      }
    }

    function dealAnimation() {
      G.busy = true;
      const from = game.dealFrom();
      board.classList.add('no-anim');
      for (const c of game.cards) {
        const el = G.els[c.id];
        el.style.transition = '';
        el.style.transform = `translate(${from.x}px, ${from.y}px)`;
        el.classList.add('down');
        el.classList.remove('flip3d');
        clearTimeout(el._ft);
        clearTimeout(el._zt);
        el._zt = null;
        el.style.zIndex = 10 + c.id;
        el._key = from.key;
      }
      void board.offsetWidth;
      board.classList.remove('no-anim');

      const stagger = {};
      const order = game.dealOrder();
      order.forEach((id, k) => { stagger[id] = 120 + k * 42; });
      render({ stagger });
      setTimeout(() => {
        for (const c of game.cards) G.els[c.id].style.transitionDelay = G.els[c.id].firstChild.style.transitionDelay = '';
        G.busy = false;
        autoPlay(game.afterDealWait); // the deal's flips have finished by now
      }, 120 + order.length * 42 + 520);
    }

    // ---------- Building the DOM ----------

    function makeSlot(cls, html = '') {
      const el = document.createElement('div');
      el.className = 'slot ' + cls;
      el.innerHTML = html;
      board.appendChild(el);
      return el;
    }

    function build() {
      game.buildSlots();
      for (const c of game.cards) {
        const el = document.createElement('div');
        el.className = `card ${c.color} down`;
        el.dataset.id = c.id;
        el.setAttribute('aria-label', game.cardLabel(c));
        const back = game.backHTML ? game.backHTML(c) : '';
        el.innerHTML = `<div class="inner"><div class="face">${game.faceHTML(c)}</div><div class="back">${back}</div></div>`;
        board.appendChild(el);
        G.els[c.id] = el;
      }
    }

    // ---------- Pointer input ----------

    function overlap(a, b) {
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      return w > 0 && h > 0 ? w * h : 0;
    }

    function findTarget(d) {
      const r = { x: d.base[0].x + d.dx, y: d.base[0].y + d.dy, w: G.L.cw, h: G.L.ch };
      let best = null;
      let bestArea = 0;
      for (const zone of game.dropZones()) {
        if (!game.canDrop(d.ids, d.from, zone.to)) continue;
        const a = overlap(r, zone);
        if (a > bestArea) { bestArea = a; best = zone.to; }
      }
      return best;
    }

    function setDropHighlight(to) {
      const el = to ? game.targetEl(to) : null;
      if (el === dropEl) return;
      if (dropEl) dropEl.classList.remove('drop-ok');
      dropEl = el;
      if (el) el.classList.add('drop-ok');
    }

    board.addEventListener('pointerdown', e => {
      if (G.busy || G.meta.won || drag || e.button > 0) return;
      const el = e.target.closest('.card');
      if (!el) return;
      const id = +el.dataset.id;
      const loc = game.locate(id);
      if (game.press && game.press(id, loc)) return;
      const ids = game.grab(loc);
      if (!ids) {
        shake([id]);
        return;
      }
      e.preventDefault();
      drag = {
        pointer: e.pointerId, ids, from: loc,
        sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, moved: false,
        base: ids.map(i => ({ x: G.P[i].x, y: G.P[i].y })),
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
          const el = G.els[id];
          el.classList.add('dragging');
          clearTimeout(el._zt);
          el._zt = null;
          el.style.zIndex = 5000 + k;
        });
      }
      drag.dx = dx;
      drag.dy = dy;
      drag.ids.forEach((id, k) => {
        G.els[id].style.transform = `translate(${Math.round(drag.base[k].x + dx)}px, ${Math.round(drag.base[k].y + dy)}px)`;
      });
      setDropHighlight(findTarget(drag));
    });

    function endDrag(e, cancelled) {
      if (!drag || e.pointerId !== drag.pointer) return;
      const d = drag;
      drag = null;
      d.ids.forEach(id => G.els[id].classList.remove('dragging'));
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
        const el = G.els[id];
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

    function updateHud() {
      $('#wins').textContent = G.stats.wins;
      $('#moves').textContent = G.state.moves;
      $('#time').textContent = fmtTime(elapsed());
      $('#btn-undo').disabled = !G.history.length || G.meta.won;
      if (game.updateHud) game.updateHud();
    }

    // ---------- Winning ----------

    function checkWin() {
      if (G.meta.won || !game.isWon()) return;
      G.meta.won = true;
      clock.acc = elapsed();
      clock.since = null;
      G.stats.wins++;
      if (!G.stats.best || clock.acc < G.stats.best) G.stats.best = clock.acc;
      saveStats();
      if (daily) Daily.markDone(daily.date, { moves: G.state.moves, time: clock.acc });
      updateHud();
      bump($('#wins'));
      celebrate();
    }

    function celebrate() {
      G.busy = true;
      clearHint();
      winTimers.push(setTimeout(() => {
        game.winOrder().forEach((id, i) => {
          const el = G.els[id];
          const x = Math.random() * (G.L.w - G.L.cw);
          const y = Math.random() * (G.L.h - G.L.ch);
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

    // A way out to the games menu from the win screen, for when you don't want another deal.
    const gamesButton = (tone = '') => `
      <a class="btn${tone ? ' ' + tone : ''}" href="../">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        All games
      </a>`;

    function showWinModal() {
      const moves = `<div><b>${G.state.moves}</b><span>Moves</span></div>`;
      const time = `<div><b>${fmtTime(G.meta.elapsed || clock.acc)}</b><span>Time</span></div>`;
      if (daily) {
        const total = Daily.count();
        openModal(`
          <div class="win-panel">
            <h2>Daily Deal complete</h2>
            <p class="sub">${Daily.format(daily.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
            <div class="win-stats">
              ${moves}
              ${time}
              <div><b>${total}</b><span>Daily deal${total === 1 ? '' : 's'} done</span></div>
            </div>
            <div class="row">
              <a class="btn" href="../daily/">Daily archive</a>
              ${gamesButton('gold')}
            </div>
          </div>`);
        confetti();
        return;
      }
      openModal(`
        <div class="win-panel">
          <h2>Victory</h2>
          <p class="sub">${game.winText}</p>
          <div class="win-stats">
            ${moves}
            ${time}
            <div><b>${G.stats.wins}</b><span>Total wins</span></div>
            <div><b>${G.stats.best ? fmtTime(G.stats.best) : '—'}</b><span>Best time</span></div>
          </div>
          ${game.dealOptions
            ? `<h3>Deal again</h3>${dealPicker()}<div class="row">${gamesButton()}</div>`
            : `<div class="row">${gamesButton()}<button class="btn gold" data-action="new-force">Deal again</button></div>`}
        </div>`);
      confetti();
    }

    function confetti() {
      const css = getComputedStyle(document.documentElement);
      const colors = (css.getPropertyValue('--confetti') || '#ecd396 #d4af5f #c4314b #fbf6ea #7ef0c5').trim().split(/\s+/);
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
      const { wins, played, best } = G.stats;
      openModal(`
        <button class="close-x" data-action="close" aria-label="Close">✕</button>
        ${game.rulesHTML()}
        <h3>Your record</h3>
        <ul><li>${wins} win${wins === 1 ? '' : 's'} from ${played} game${played === 1 ? '' : 's'} played${best ? ` · best time ${fmtTime(best)}` : ''}.</li></ul>
        <div class="row"><button class="btn gold" data-action="close">Let's play</button></div>`);
    }

    function showSettings() {
      if (!game.settingsHTML && game.shading === false) return;
      openModal(`
        <button class="close-x" data-action="close" aria-label="Close">✕</button>
        <h2>Settings</h2>
        ${game.dealOptions && !daily ? dealSetting() : ''}
        ${game.settingsHTML ? game.settingsHTML() : ''}
        ${game.shading === false ? '' : shadingSetting()}
        <div class="row"><button class="btn gold" data-action="close">Done</button></div>`);
    }

    // Every game that marks buried cards as `locked` gets this setting; one that never does
    // passes `shading: false` to leave it out.
    const shading = () => game.shading !== false && G.settings.shadeBuried !== false;

    const shadingSetting = () => `
      <label class="toggle">
        <input type="checkbox" data-setting="shadeBuried"${shading() ? ' checked' : ''}>
        <span class="switch" aria-hidden="true"></span>
        <span><b>Shade buried cards</b><small>Darkens cards that are covered by ones you can play, so it's easy to see what can move.</small></span>
      </label>`;

    // The buttons for a game's deal options. `action` is what a pick does; `mark` flags the current one.
    function dealPicker(action, mark = true) {
      const { key, choices } = game.dealOptions;
      return `<div class="deal-options">${choices.map((c, i) => `
        <button class="deal-opt${mark && c.value === G.settings[key] ? ' current' : ''}" data-action="${action}" data-choice="${i}">
          ${c.icon || ''}<b>${c.label}</b><small>${c.sub}</small>
        </button>`).join('')}</div>`;
    }

    // The deal option as a Settings entry. An untouched deal is redealt at once; otherwise the
    // change waits for the next deal so a game in progress keeps its rules.
    function dealSetting() {
      const later = G.state.moves > 0;
      return `<div class="deal-setting">
        <b>${game.dealOptions.title}</b>
        <small>${later ? 'Takes effect from your next deal.' : 'Changing it deals a fresh game.'}</small>
        ${dealPicker('set-option')}
      </div>`;
    }

    function setDealOption(choice) {
      const { key, choices } = game.dealOptions;
      if (G.settings[key] === choices[choice].value) return;
      G.settings[key] = choices[choice].value;
      saveSettings();
      if (G.state.moves === 0) {
        deal();
        return;
      }
      modal.querySelectorAll('.deal-setting .deal-opt').forEach((b, i) => b.classList.toggle('current', i === choice));
    }

    // First visit to a game with deal options: ask before the first deal. The only way out is
    // to pick, since the board has nothing on it until then.
    function askDealOption(then) {
      mustChoose = true;
      onChosen = then;
      openModal(`
        <h2>Welcome</h2>
        <p class="sub">${game.dealOptions.prompt} You can change this any time in Settings.</p>
        ${dealPicker('deal', false)}`);
    }

    function newGame(force = false) {
      const inProgress = !G.meta.won && G.state.moves > 0;
      if (!force && inProgress && daily) {
        openModal(`
          <h2>Restart this deal?</h2>
          <p class="sub">The same cards are dealt again from the start.</p>
          <div class="row">
            <button class="btn" data-action="close">Keep playing</button>
            <button class="btn gold" data-action="new-force">Restart</button>
          </div>`);
        return;
      }
      if (!force && inProgress) {
        openModal(`
          <h2>New game?</h2>
          <p class="sub">The current game will be abandoned.</p>
          <div class="row">
            <button class="btn" data-action="close">Keep playing</button>
            <button class="btn gold" data-action="new-force">Deal new game</button>
          </div>`);
        return;
      }
      deal();
    }

    function deal(choice = null) {
      if (choice !== null) {
        G.settings[game.dealOptions.key] = game.dealOptions.choices[choice].value;
        saveSettings();
      }
      mustChoose = false;
      if (game.dealt) game.dealt();
      if (modalOpen()) closeModal();
      winTimers.forEach(clearTimeout);
      winTimers = [];
      stopAutoPlay();
      autoRun = 0;
      clearHint();
      G.state = freshState();
      G.history = [];
      G.meta = { counted: false, won: false, elapsed: 0 };
      clock.acc = 0;
      clock.since = null;
      hintIndex = 0;
      dealAnimation();
      updateHud();
      save();
      if (onChosen) {
        onChosen();
        onChosen = null;
      }
    }

    modal.addEventListener('click', e => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'close') closeModal();
      else if (action === 'new-force') deal();
      else if (action === 'deal') deal(+e.target.closest('[data-choice]').dataset.choice);
      else if (action === 'set-option') setDealOption(+e.target.closest('[data-choice]').dataset.choice);
      else if (e.target === modal && !mustChoose) closeModal();
    });

    modal.addEventListener('change', e => {
      const key = e.target.dataset.setting;
      if (!key) return;
      G.settings[key] = e.target.checked;
      saveSettings();
      if (key === 'shadeBuried') {
        if (!G.meta.won) render();
        return;
      }
      if (game.onSetting) game.onSetting(key);
    });

    // ---------- Wiring ----------

    function wire() {
      $('#btn-new').addEventListener('click', () => newGame());
      $('#btn-undo').addEventListener('click', undo);
      $('#btn-hint').addEventListener('click', showHint);
      $('#btn-rules').addEventListener('click', showRules);
      $('#btn-settings')?.addEventListener('click', showSettings);
      if (game.wire) game.wire();

      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modalOpen()) {
          if (!mustChoose) closeModal();
          return;
        }
        if (modalOpen() || e.altKey || e.metaKey) return;
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
        else if (e.ctrlKey) return;
        else if (key === 'h') showHint();
        else if (key === 'n') newGame();
        else if (key === 'r') showRules();
        else if (key === 's') showSettings();
        else if (game.onKey) game.onKey(key, e);
      });

      let resizeTimer = null;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          layout();
          if (!G.meta.won) render({ instant: true });
        }, 80);
      });

      window.addEventListener('pagehide', save);
      document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
    }

    // ---------- Start ----------

    // Show that this is a daily deal, and that "New" can only start the same deal over.
    function labelDaily() {
      const when = Daily.format(daily.date, { month: 'short', day: 'numeric' });
      document.title = `Daily Deal, ${when} · ${daily.name}`;
      document.body.classList.add('daily-deal');
      hud.querySelector('.tagline').textContent = `Daily Deal · ${when}`;
      const restart = $('#btn-new');
      restart.title = 'Restart this deal (N)';
      restart.querySelector('span').textContent = 'Restart';
    }

    function start() {
      G.stats = Object.assign({ wins: 0, played: 0, best: null }, load(KEYS.stats, {}));
      const storedSettings = load(KEYS.settings, {});
      G.settings = Object.assign({ shadeBuried: true }, game.settingsDefaults, storedSettings);
      // A daily deal brings its own variation, so the player's choice stays unmade if it was.
      if (daily && game.dealOptions && !(game.dealOptions.key in storedSettings)) delete G.settings[game.dealOptions.key];
      build();
      layout();
      if (daily) labelDaily();
      wire();
      const saved = load(KEYS.game, null);
      let ok = false;
      try { ok = !!(saved && saved.state && saved.meta && !saved.meta.won && game.validState(saved.state)); } catch { ok = false; }
      if (ok) {
        G.state = saved.state;
        G.history = saved.history || [];
        G.meta = saved.meta;
        clock.acc = G.meta.elapsed || 0;
        clock.since = G.meta.counted ? Date.now() : null;
        render({ instant: true });
        updateHud();
        autoPlay();
      } else {
        G.state = freshState();
        G.meta = { counted: false, won: false, elapsed: 0 };
        const welcome = () => { if (!G.stats.played) setTimeout(showRules, 1600); };
        if (game.dealOptions && !daily && !(game.dealOptions.key in storedSettings)) askDealOption(welcome);
        else {
          deal();
          welcome();
        }
        if (daily && Daily.isDone(daily.date)) toast("You've already completed this deal. Playing it again won't change your total.");
      }
      setInterval(() => { $('#time').textContent = fmtTime(elapsed()); }, 1000);
    }

    Object.assign(G, {
      makeSlot, move, snapshot, committed, layout, render, updateHud, autoPlay, stopAutoPlay,
      toast, shake, bump, start,
    });
    return G;
  }

  return { SUITS, TEXT_STYLE, suitSVG, last, same, place, shuffle, fmtTime, paced, createGame };
})();
