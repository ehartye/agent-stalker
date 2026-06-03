// Lightweight instant tooltip. One element appended to <body> (so it is never
// clipped by the section cards' overflow:hidden or the scrolling panel), shown
// on hover of any element carrying a `data-tip` attribute. No delay, no library.

let tipEl = null;

function place(target) {
  const r = target.getBoundingClientRect();
  const tw = tipEl.offsetWidth;   // reading offset* forces layout with the new text
  const th = tipEl.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  let top = r.bottom + 8;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  if (top + th > window.innerHeight - 8) top = r.top - th - 8; // flip above if needed
  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
}

export function initTooltips() {
  if (tipEl) return;
  tipEl = document.createElement('div');
  tipEl.className = 'tooltip';
  document.body.appendChild(tipEl);

  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) return;
    tipEl.textContent = t.dataset.tip;
    place(t);
    tipEl.classList.add('visible');
  });

  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-tip]')) tipEl.classList.remove('visible');
  });

  // Anything that moves the anchored element (scroll) should drop the tooltip.
  window.addEventListener('scroll', () => tipEl.classList.remove('visible'), true);
}
