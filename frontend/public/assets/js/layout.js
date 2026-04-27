/* layout.js — injects shared header + footer so every page stays in sync */
(function () {
  'use strict';

  const path = location.pathname.replace(/\/+$/, '') || '/';
  const isActive = (href) => {
    if (href === '/') return path === '/';
    return path === href || path.startsWith(href + '/');
  };

  const navItems = [
    { href: '/pricing', label: 'Pricing' },
    { href: '/docs',    label: 'Docs' },
    { href: '/about',   label: 'About' }
  ];

  const headerHTML = `
    <header class="site-header">
      <div class="container">
        <a class="brand-mark" href="/">
          <span class="dot">H</span>
          <span>HOPEZ.AI</span>
        </a>
        <nav class="nav-links">
          ${navItems.map(n =>
            `<a href="${n.href}" class="${isActive(n.href) ? 'active' : ''}">${n.label}</a>`
          ).join('')}
        </nav>
        <div class="nav-actions" data-auth>
          <a class="btn ghost" href="/login">Sign in</a>
          <a class="btn primary" href="/signup">Get started</a>
        </div>
      </div>
    </header>
  `;

  const footerHTML = `
    <footer class="site-footer">
      <div class="container">
        <div>© ${new Date().getFullYear()} HOPEZ.AI — Reliable AI infrastructure for developers.</div>
        <div>
          <a href="/pricing">Pricing</a>
          <a href="/docs">Docs</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
        </div>
      </div>
    </footer>
  `;

  document.addEventListener('DOMContentLoaded', () => {
    const headerSlot = document.querySelector('[data-slot="header"]');
    const footerSlot = document.querySelector('[data-slot="footer"]');
    if (headerSlot) headerSlot.outerHTML = headerHTML;
    if (footerSlot) footerSlot.outerHTML = footerHTML;
    if (window.HZ && HZ.hydrateNav) HZ.hydrateNav();
  });
})();
