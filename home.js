// The Daily Deal banner on the games screen.
(() => {
  'use strict';

  const banner = document.querySelector('#daily');

  function render() {
    const d = Daily.deal(Daily.today());
    const done = Daily.isDone(d.date);
    const total = Daily.count();
    banner.innerHTML = `
      <div class="daily-date" aria-hidden="true">
        <span>${Daily.format(d.date, { month: 'short' })}</span>
        <b>${Daily.format(d.date, { day: 'numeric' })}</b>
      </div>
      <div class="daily-info">
        <h2>Daily Deal</h2>
        <p>${Daily.format(d.date, { weekday: 'long', month: 'long', day: 'numeric' })} · ${Daily.label(d)}</p>
        <p class="daily-note">One deal a day, the same for everyone${d.verified ? ', and checked to be winnable' : ''}.</p>
      </div>
      <div class="daily-total"><b>${total}</b><span>Completed</span></div>
      <div class="daily-actions">
        <a class="play${done ? ' done' : ''}" href="${Daily.href(d)}">${done ? '✓ Completed' : 'Play today’s deal'}</a>
        <a class="daily-link" href="daily/">Archive</a>
      </div>`;
  }

  render();
  // Coming back to this page, possibly on a later day or after finishing the deal.
  window.addEventListener('pageshow', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
})();
