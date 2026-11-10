// Miniature tabletops for the game cards on the games screen: each one is a game caught mid-play,
// laid out the way the real table is, so the preview says how the game plays at a glance.
(() => {
  'use strict';

  // Card tokens:
  //   'b'    face down            '_'  empty spot
  //   'Ks'   rank + suit, suits s h d c (cards), f w e (Elements' Fire, Water, Earth)
  //   '@h'   a face card shown as a crest of its suit
  //   '=h'   a sealed or collapsed pile of that suit's faces
  //   '*'    Elements' star
  // Each scene has a top row (indexed by column, sparse) and the tableau's columns.
  const SCENES = {
    klondike: {
      top: { 0: ['b'], 1: ['6c'], 3: ['2h'], 4: ['As'], 5: ['_'], 6: ['_'] },
      cols: [
        ['Ks', 'Qh', 'Jc'],
        ['b', '9d'],
        ['b', 'b', '5s', '4h'],
        ['b', 'b', 'b', 'Jd', '10s', '9h'],
        ['b', 'b', 'b', 'b', '7c'],
        ['b', 'b', 'b', 'b', 'b', 'Qs', 'Jh'],
        ['b', 'b', 'b', 'b', 'b', 'b', '8s'],
      ],
    },
    freecell: {
      top: { 0: ['Qd'], 1: ['_'], 2: ['_'], 3: ['7s'], 4: ['3h'], 5: ['As'], 6: ['2d'], 7: ['_'] },
      cols: [
        ['9c', '4d', 'Kh', 'Qc', 'Jd'],
        ['6s', 'Ts', '8h', '7c'],
        ['Jh', '3c', '5d', 'Ks', '4s'],
        ['8c', '2s', 'Kd', 'Qs'],
        ['6h', 'Ac', '9h', 'Td', '9s', '8d'],
        ['4c', 'Jc', '5h'],
        ['3s', '7h', 'Kc', '5c', '4h'],
        ['8s', '6d', '2c', 'Th', '9d'],
      ],
    },
    spider: {
      top: { 0: ['b'], 2: ['Ks'], 3: ['Kh'], 4: ['_'], 5: ['_'], 6: ['_'], 7: ['_'], 8: ['_'], 9: ['_'] },
      cols: [
        ['b', 'b', 'b', '9s', '8s', '7s'],
        ['b', 'b', 'Kh', 'Qh'],
        ['b', '5h', '4s', '3s'],
        ['b', 'b', 'b', 'b', 'Js'],
        ['b', 'b', '7h', '6h', '5h', '4h'],
        [],
        ['b', 'b', 'b', '2s', 'As'],
        ['b', 'Qs', 'Jh', 'Ts', '9s'],
        ['b', 'b', 'b', 'b', '6s'],
        ['b', 'b', '8h', '3h'],
      ],
    },
    clearview: {
      top: { 0: ['b'], 1: ['Jc'], 3: ['Ad'], 4: ['2c'], 5: ['_'], 6: ['_'] },
      cols: [
        ['8h'],
        ['Qc', '5s'],
        ['4c', 'Kd', '3h'],
        ['9s', '6d', '2s', 'Jh'],
        ['Th', 'As', '7c', '6h', '5c'],
        ['3d', 'Qh', '8c', 'Ts', '9h', '8s'],
        ['Kh', '4s', '9c', '6s', 'Qd', 'Js', 'Td'],
      ],
    },
    quartet: {
      top: { 0: ['@s'] },
      cols: [
        ['Ts', '9h', '8s', '7h', '6s'],
        ['=h'],
        ['8d', '@c', 'Tc', '9d'],
        ['7c', '@d', '6h'],
        ['Th', '@c', '9c', '8h', '7s'],
        ['6d', '9s', '@d', 'Td'],
        ['@s', '7d', '8c'],
        ['6c', '@d', '@s', '@c'],
        [],
      ],
    },
    elements: {
      top: { 0: ['=f'], 1: ['@e'], 2: ['_'], 4: ['*'], 5: ['3f'], 6: ['2w'], 7: ['_'] },
      cols: [
        ['5w', '9e', '7f', '6w'],
        ['@w', '4e', '8w', '7e'],
        ['9f', '3e', '6e'],
        ['2e', '8f', '@w', '5f', '4w'],
        ['7w', '@e', '9w'],
        ['1e', '6f', '5e', '8e', '4f'],
        ['3w', '@w', '9e'],
        ['4w', '@e', '1e', '5w'],
      ],
    },
  };

  const SYM = {
    f: '<path d="M52 2C56 22 80 34 80 62C80 82 67 96 50 96C33 96 20 83 20 64C20 50 27 40 35 31C35 43 40 51 47 55C43 38 44 18 52 2Z"/>',
    w: '<path d="M50 3C62 26 83 45 83 66C83 84 69 97 50 97C31 97 17 84 17 66C17 45 38 26 50 3Z"/>',
    e: '<path d="M2 90L35 30L49 54L64 24L98 90Z"/>',
    '*': '<path d="M50 3L62 37L98 38L69 60L80 95L50 74L20 95L31 60L2 38L38 37Z"/>',
  };
  const PIP = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const CLASS = { s: '', c: '', h: 'red', d: 'red', f: 'fire', w: 'water', e: 'earth' };
  const pip = s => SYM[s] ? `<svg viewBox="0 0 100 100">${SYM[s]}</svg>` : PIP[s];

  function cardHTML(token) {
    const cls = ['mc'];
    let inner = '';
    if (token === 'b') cls.push('back');
    else if (token === '_') cls.push('slot');
    else if (token === '*') { cls.push('star'); inner = `<i class="big">${pip('*')}</i>`; }
    else {
      const suit = token.slice(-1), rank = token.slice(0, -1);
      if (CLASS[suit]) cls.push(CLASS[suit]);
      if (rank === '@') { cls.push('crest'); inner = `<i class="big">${pip(suit)}</i>`; }
      else if (rank === '=') { cls.push('crest', 'sealed'); inner = `<i class="big">${pip(suit)}</i>`; }
      else inner = `<b>${rank === 'T' ? '10' : rank}<i>${pip(suit)}</i></b><i class="big">${pip(suit)}</i>`;
    }
    return [cls.join(' '), inner];
  }

  function build(el, scene) {
    const n = scene.cols.length;
    // Cards grow to fill the preview's width, up to a size where the table still reads as a table
    const gap = n > 8 ? 4 : 5;
    const w = Math.max(18, Math.min(34, Math.floor((el.clientWidth - 28 - (n - 1) * gap) / n)));
    const h = Math.round(w * 1.4);
    // Tableau fan offsets, and the tableau's distance below the top row
    const UP = Math.round(w * 0.44), DOWN = Math.round(w * 0.16), ROW = h + Math.round(w * 0.35);
    const parts = [];
    const place = (token, x, y, z) => {
      const [cls, inner] = cardHTML(token);
      parts.push(`<span class="${cls}" style="left:${x}px;top:${y}px;z-index:${z}">${inner}</span>`);
    };
    for (const [c, pile] of Object.entries(scene.top)) {
      pile.forEach((t, i) => place(t, c * (w + gap), 0, i + 1));
    }
    scene.cols.forEach((col, c) => {
      if (!col.length) { place('_', c * (w + gap), ROW, 0); return; }
      let y = ROW;
      col.forEach((t, i) => {
        place(t, c * (w + gap), y, i + 1);
        y += t === 'b' ? DOWN : UP;
      });
    });
    el.innerHTML = `<div class="scene" style="width:${n * w + (n - 1) * gap}px;--w:${w}px;--h:${h}px;font-size:${w / 3}px">${parts.join('')}</div>`;
  }

  // Rebuilt whenever a preview changes width, so the cards stay as large as the space allows
  const widths = new WeakMap();
  const resized = new ResizeObserver(entries => {
    for (const { target } of entries) {
      if (widths.get(target) === target.clientWidth) continue;
      widths.set(target, target.clientWidth);
      build(target, SCENES[target.dataset.scene]);
    }
  });
  for (const el of document.querySelectorAll('.preview[data-scene]')) {
    if (SCENES[el.dataset.scene]) resized.observe(el);
  }
})();
