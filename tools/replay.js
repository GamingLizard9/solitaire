// Plays a solver's moves through the real game code, the same engine.js and game.js the site
// serves, running on a stand-in for the browser. This is what makes a solver's answer trustworthy:
// a move the real rules would refuse, or a deal laid out differently from what the solver assumed,
// fails here instead of reaching players.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const scripts = {};
const script = file => (scripts[file] ||= new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file }));

// An element that accepts anything the engine does to it: unknown properties are more of the same.
function fakeElement() {
  const props = {};
  const el = new Proxy(function () {}, {
    get(_, key) {
      if (key === Symbol.toPrimitive) return () => 0;
      if (key in props) return props[key];
      return (props[key] = fakeElement());
    },
    set(_, key, value) {
      props[key] = value;
      return true;
    },
    apply: () => fakeElement(),
  });
  return el;
}

function browser(date, table, storage) {
  const context = vm.createContext({
    console,
    URLSearchParams,
    DAILY_TABLE: table,
    location: {
      search: `?daily=${date}`,
      replace: url => { throw new Error(`Sent to ${url}: the deal belongs to another game`); },
    },
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    document: { querySelector: fakeElement, createElement: fakeElement, documentElement: fakeElement(), body: fakeElement(), addEventListener() {}, hidden: false },
    addEventListener() {},
    getComputedStyle: fakeElement,
    requestAnimationFrame() {},
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
  });
  context.window = context;
  // The site won't open a deal dated in the future, so this one's date has to be "today".
  vm.runInContext(`{
    const Real = Date;
    const now = Real.parse('${date}T18:00:00Z'); // midday in US Eastern, where days turn over
    globalThis.Date = class extends Real {
      constructor(...args) { args.length ? super(...args) : super(now); }
      static now() { return now; }
    };
  }`, context);
  return context;
}

// Throws unless `moves` wins `date`'s deal, as listed at the end of `table`, in the real game.
function replay(date, play, table, moves) {
  const storage = new Map([[`${play.game}.settings.v1`, JSON.stringify({ autoSafe: false })]]);
  const context = browser(date, table, storage);
  script('shared/daily.js').runInContext(context);
  script('shared/engine.js').runInContext(context);

  let game;
  let G;
  const { createGame } = context.Solitaire;
  context.Solitaire.createGame = definition => {
    game = definition;
    G = createGame(definition);
    return G;
  };
  script(`${play.game}/game.js`).runInContext(context);

  const settle = () => {
    G.stopAutoPlay();
    G.busy = false;
  };
  const fail = (m, k, why) => { throw new Error(`${date}: move ${k + 1} of ${moves.length} (${JSON.stringify(m)}) ${why}`); };

  settle();
  if (play.value && G.state.draw !== play.value) throw new Error(`${date}: dealt draw ${G.state.draw}, expected ${play.value}`);
  moves.forEach((m, k) => {
    if (m.draw) {
      game.onKey(' ', { preventDefault() {} });
    } else if (m.collapse !== undefined) {
      // Elements: press a suit's collapse button, as its number key does.
      const before = JSON.stringify(G.state);
      game.onKey(String(m.collapse + 1), { preventDefault() {} });
      if (JSON.stringify(G.state) === before) fail(m, k, 'is refused by the rules');
    } else {
      const from = game.locate(m.card);
      const ids = game.grab(from);
      if (!ids || ids[0] !== m.card) fail(m, k, 'picks up a card that can\'t be picked up');
      if (!game.canDrop(ids, from, m.to)) fail(m, k, 'is refused by the rules');
      G.move(from, ids, m.to);
    }
    settle();
    // Automatic steps that aren't optional, like Quartet's sealing, happen as they would in play.
    let step;
    while (game.nextAuto && (step = game.nextAuto())) {
      step();
      G.committed(false, true);
      settle();
    }
  });

  if (!game.isWon() || !G.meta.won) throw new Error(`${date}: every move was legal, but the game isn't won`);
  if (!context.Daily.isDone(date)) throw new Error(`${date}: the win wasn't recorded`);
}

module.exports = { replay };
