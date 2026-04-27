/* hopez.js — shared frontend helpers */
(function () {
  'use strict';

  // Same-origin: the frontend reverse-proxies /api and /v1 to the backend,
  // so cookies stay first-party and CORS is a non-issue in dev.
  const API = '';

  async function request(path, opts = {}) {
    const res = await fetch(API + path, {
      method: opts.method || 'GET',
      credentials: 'include',
      headers: Object.assign(
        { 'Accept': 'application/json' },
        opts.body ? { 'Content-Type': 'application/json' } : {},
        opts.headers || {}
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `Request failed (${res.status})`;
      const err = new Error(msg); err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  const HZ = {
    api: {
      me:        () => request('/api/auth/me'),
      signup:    (b) => request('/api/auth/signup',   { method: 'POST', body: b }),
      login:     (b) => request('/api/auth/login',    { method: 'POST', body: b }),
      logout:    ()  => request('/api/auth/logout',   { method: 'POST' }),
      forgot:    (b) => request('/api/auth/forgot',   { method: 'POST', body: b }),
      reset:     (b) => request('/api/auth/reset',    { method: 'POST', body: b }),

      plans:     ()  => request('/api/auth/plans'),
      subscribe: (b) => request('/api/auth/subscribe',{ method: 'POST', body: b }),
      checkout:  (b) => request('/api/auth/checkout', { method: 'POST', body: b }),
      payments:  ()  => request('/api/auth/payments'),

      keys:      ()  => request('/api/auth/keys'),
      createKey: (b) => request('/api/auth/keys',     { method: 'POST', body: b }),
      revokeKey: (id)=> request('/api/auth/keys/' + id, { method: 'DELETE' }),
    },

    toast(msg, kind = '') {
      let wrap = document.querySelector('.toast-wrap');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'toast-wrap';
        document.body.appendChild(wrap);
      }
      const t = document.createElement('div');
      t.className = 'toast ' + kind;
      t.textContent = msg;
      wrap.appendChild(t);
      setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .25s'; }, 2400);
      setTimeout(() => t.remove(), 2700);
    },

    formatDate(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      return d.toLocaleString();
    },

    money(cents) {
      if (cents == null) return '—';
      return '$' + (cents / 100).toFixed(2);
    },

    copy(text) {
      navigator.clipboard.writeText(text).then(
        () => HZ.toast('Copied to clipboard', 'success'),
        () => HZ.toast('Copy failed', 'danger')
      );
    },

    qs(k) { return new URLSearchParams(location.search).get(k); },

    // Wire up signed-in/signed-out nav state on every page
    async hydrateNav() {
      const auth = document.querySelector('[data-auth]');
      if (!auth) return;
      try {
        const me = await HZ.api.me();
        auth.innerHTML = `
          <a class="btn ghost" href="/dashboard">Console</a>
          <button class="btn" id="nav-logout">Sign out</button>`;
        document.getElementById('nav-logout').onclick = async () => {
          await HZ.api.logout(); location.href = '/';
        };
        return me;
      } catch (_) {
        auth.innerHTML = `
          <a class="btn ghost" href="/login">Sign in</a>
          <a class="btn primary" href="/signup">Get started</a>`;
        return null;
      }
    },

    requireAuth(redirect = '/login') {
      return HZ.api.me().catch(() => { location.href = redirect; throw new Error('unauth'); });
    }
  };

  window.HZ = HZ;
})();
