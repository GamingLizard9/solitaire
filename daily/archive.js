// The archive: today's deal, then every past one by month, newest first.
(() => {
  'use strict';

  const list = document.querySelector('#deals');
  const total = document.querySelector('#total');

  function tile(date) {
    const d = Daily.deal(date);
    const done = Daily.isDone(date);
    return `
      <a class="deal${done ? ' done' : ''}" href="${Daily.href(d, '../')}">
        <span class="deal-day">${Daily.format(date, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        <span class="deal-game">${Daily.label(d)}</span>
        <span class="deal-status">${done ? '✓ Completed' : 'Play'}</span>
      </a>`;
  }

  function render() {
    const [today, ...past] = Daily.dates();
    const count = Daily.count();
    total.textContent = `${count} completed`;

    const months = new Map();
    for (const date of past) {
      const month = Daily.format(date, { month: 'long', year: 'numeric' });
      if (!months.has(month)) months.set(month, []);
      months.get(month).push(date);
    }

    list.innerHTML = `
      <h2>Today</h2>
      <div class="deal-grid">${tile(today)}</div>
      ${past.length
        ? [...months].map(([month, dates]) => `<h2>${month}</h2><div class="deal-grid">${dates.map(tile).join('')}</div>`).join('')
        : `<h2>Past deals</h2><p class="archive-empty">Nothing here yet. Each day's deal joins the archive the day after, starting with today's.</p>`}`;
  }

  render();
  // Coming back from a deal, possibly on a later day.
  window.addEventListener('pageshow', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
})();
