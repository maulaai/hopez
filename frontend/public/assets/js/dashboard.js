/* dashboard.js — console behaviour */
(function () {
  'use strict';

  let me = null;
  let plansCache = null;

  // Tabs
  const showTab = (name) => {
    document.querySelectorAll('.sidebar a[data-tab]').forEach(a => {
      a.classList.toggle('active', a.dataset.tab === name);
    });
    document.querySelectorAll('section[data-pane]').forEach(s => {
      s.classList.toggle('hidden', s.dataset.pane !== name);
    });
    if (history.replaceState) history.replaceState(null, '', '#' + name);
  };
  window.showTab = showTab;

  document.querySelectorAll('.sidebar a[data-tab]').forEach(a => {
    a.addEventListener('click', (e) => { e.preventDefault(); showTab(a.dataset.tab); });
  });

  document.getElementById('logout').onclick = async () => {
    try { await HZ.api.logout(); } finally { location.href = '/'; }
  };

  // ---------- Boot ----------
  (async function boot() {
    try { me = await HZ.requireAuth(); } catch (_) { return; }

    // Header
    document.getElementById('who').textContent = me.user.email;

    // Reveal admin link if applicable
    if (me.user.role === 'admin') {
      const adminLink = document.getElementById('adminLink');
      if (adminLink) adminLink.classList.remove('hidden');
    }

    // Welcome handling — auto-subscribe selected plan if free, else upgrade prompt later
    if (HZ.qs('welcome') === '1') {
      HZ.toast('Welcome to HOPEZ.AI 🎉', 'success');
      const wantedPlan = HZ.qs('plan');
      if (wantedPlan && wantedPlan !== me.user.plan) {
        try { await HZ.api.subscribe({ plan_id: wantedPlan }); }
        catch (_) {}
      }
    }

    plansCache = (await HZ.api.plans().catch(() => ({ plans: [] }))).plans;
    await refreshAll();

    // Initial tab from hash
    const hash = (location.hash || '').replace('#','');
    if (hash) showTab(hash);
  })();

  async function refreshAll() {
    me = await HZ.api.me();
    const plan = (plansCache || []).find(p => p.id === me.user.plan);

    // Overview stats
    document.getElementById('s-plan').textContent = plan ? plan.name : me.user.plan;
    document.getElementById('s-plan-meta').textContent = plan ? (plan.price_cents === 0 ? 'Free tier' : '$' + (plan.price_cents/100).toFixed(0) + '/mo') : '';
    document.getElementById('s-credits').textContent = (me.user.credits ?? 0).toLocaleString();
    document.getElementById('s-email').textContent = me.user.email;
    document.getElementById('s-since').textContent = 'Since ' + new Date(me.user.created_at).toLocaleDateString();

    // Settings
    document.getElementById('set-name').textContent = me.user.name || me.user.email.split('@')[0];
    document.getElementById('set-email').textContent = me.user.email;
    document.getElementById('set-since').textContent = new Date(me.user.created_at).toLocaleString();

    // Usage bar
    const quota = plan ? plan.credits : 0;
    document.getElementById('u-credits').textContent = (me.user.credits ?? 0).toLocaleString();
    document.getElementById('u-quota').textContent = quota ? quota.toLocaleString() + ' credits' : '—';
    if (quota) {
      const pct = Math.max(0, Math.min(100, (me.user.credits / quota) * 100));
      document.getElementById('u-bar').style.width = pct + '%';
    }

    // Billing
    document.getElementById('b-plan').textContent = plan ? plan.name : me.user.plan;
    renderPlans();
    renderPayments();

    // Keys
    renderKeys();
  }

  // ---------- Keys ----------
  const newKeyBtn = document.getElementById('newKeyBtn');
  const newKeyForm = document.getElementById('newKeyForm');
  const newKeyReveal = document.getElementById('newKeyReveal');

  newKeyBtn.onclick = () => { newKeyForm.classList.remove('hidden'); newKeyReveal.classList.add('hidden'); };
  document.getElementById('kCancel').onclick = () => newKeyForm.classList.add('hidden');

  document.getElementById('kf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('kErr'); err.textContent = '';
    const label = document.getElementById('klabel').value.trim();
    const ttl = parseInt(document.getElementById('kttl').value, 10);
    const otu = document.getElementById('kotu').checked;
    try {
      const r = await HZ.api.createKey({ name: label, ttl_minutes: ttl, one_time_use: otu });
      document.getElementById('newKeyText').textContent = r.key;
      const meta = [];
      if (r.bound_backend_key_label) meta.push('Bound to: <code>' + escapeHtml(r.bound_backend_key_label) + '</code>');
      if (r.one_time_use) meta.push('<strong>One-time use</strong>');
      if (r.expires_at) meta.push('Expires: ' + HZ.formatDate(r.expires_at));
      document.getElementById('newKeyMeta').innerHTML = meta.join(' &middot; ');
      newKeyForm.classList.add('hidden');
      newKeyReveal.classList.remove('hidden');
      document.getElementById('klabel').value = '';
      document.getElementById('kotu').checked = false;
      await renderKeys();
    } catch (ex) { err.textContent = ex.message; }
  });

  async function renderKeys() {
    const tbody = document.getElementById('keysBody');
    try {
      const { keys } = await HZ.api.keys();
      document.getElementById('s-keys').textContent = keys.filter(k => !k.revoked).length;
      if (!keys.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="muted" style="padding:24px;text-align:center">No keys yet. Click <strong>Create key</strong> to get started.</td></tr>`;
        return;
      }
      tbody.innerHTML = keys.map(k => {
        const tags = [];
        if (k.revoked) tags.push('<span class="tag danger">revoked</span>');
        if (k.one_time_use && !k.consumed && !k.revoked) tags.push('<span class="tag">one-time</span>');
        if (k.one_time_use && k.consumed) tags.push('<span class="tag">consumed</span>');
        if (k.expires_at && Date.now() > k.expires_at) tags.push('<span class="tag danger">expired</span>');
        const bound = k.backend_key_label
          ? `<code>${escapeHtml(k.backend_key_label)}</code>`
          : (k.backend_key_id ? `<code>pool#${k.backend_key_id}</code>`
            : '<span class="muted">shared</span>');
        const mode = k.one_time_use ? 'One-time' : 'Reusable';
        return `
        <tr${k.revoked ? ' style="opacity:.5"' : ''}>
          <td class="strong">${escapeHtml(k.name || '—')} ${tags.join(' ')}</td>
          <td><code>${escapeHtml(k.key_prefix || '')}…</code></td>
          <td>${bound}</td>
          <td>${mode}</td>
          <td>${HZ.formatDate(k.created_at)}</td>
          <td>${k.last_used_at ? HZ.formatDate(k.last_used_at) : '<span class="muted">Never</span>'}</td>
          <td style="text-align:right">${k.revoked ? '' : `<button class="btn sm danger" data-revoke="${k.id}">Revoke</button>`}</td>
        </tr>`;
      }).join('');
      tbody.querySelectorAll('[data-revoke]').forEach(btn => {
        btn.onclick = async () => {
          if (!confirm('Revoke this key? Its dedicated upstream key returns to the pool.')) return;
          try { await HZ.api.revokeKey(btn.dataset.revoke); HZ.toast('Key revoked', 'success'); await renderKeys(); }
          catch (ex) { HZ.toast(ex.message, 'danger'); }
        };
      });
    } catch (ex) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted" style="padding:24px">Failed to load: ${ex.message}</td></tr>`;
    }
  }

  // ---------- Billing ----------
  function renderPlans() {
    const wrap = document.getElementById('b-plans');
    if (!plansCache) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = plansCache.map(p => {
      const current = me.user.plan === p.id;
      return `
        <div class="plan ${p.recommended ? 'recommended' : ''}">
          ${p.recommended ? '<span class="tag brand" style="align-self:flex-start;margin-bottom:6px">Recommended</span>' : ''}
          ${current ? '<span class="tag success" style="align-self:flex-start;margin-bottom:6px">Current</span>' : ''}
          <h3>${p.name}</h3>
          <div class="muted" style="font-size:13px">${p.tagline || ''}</div>
          <div class="price">${p.price_cents === 0 ? 'Free' : '$' + (p.price_cents/100).toFixed(0)}<small>${p.price_cents === 0 ? '' : ' / mo'}</small></div>
          <div class="muted" style="font-size:13px">${p.credits.toLocaleString()} credits</div>
          <ul>${(p.features||[]).map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
          <button class="btn ${p.recommended ? 'brand' : ''}" ${current ? 'disabled' : ''} data-plan="${p.id}">
            ${current ? 'Current plan' : (p.price_cents === 0 ? 'Switch to Free' : 'Upgrade')}
          </button>
        </div>`;
    }).join('');
    wrap.querySelectorAll('[data-plan]').forEach(b => {
      b.onclick = async () => {
        const id = b.dataset.plan;
        try {
          if (id === 'free') { await HZ.api.subscribe({ plan_id: id }); }
          else { await HZ.api.checkout({ plan_id: id }); }
          HZ.toast('Plan updated', 'success');
          await refreshAll();
        } catch (ex) { HZ.toast(ex.message, 'danger'); }
      };
    });
  }

  document.getElementById('b-buy').onclick = async () => {
    const id = me.user.plan === 'free' ? 'starter' : me.user.plan;
    try {
      await HZ.api.checkout({ plan_id: id });
      HZ.toast('Credits added', 'success');
      await refreshAll();
    } catch (ex) { HZ.toast(ex.message, 'danger'); }
  };

  async function renderPayments() {
    const tb = document.getElementById('b-payments');
    try {
      const { payments } = await HZ.api.payments();
      if (!payments.length) {
        tb.innerHTML = `<tr><td colspan="5" class="muted" style="padding:24px;text-align:center">No payments yet.</td></tr>`;
        return;
      }
      tb.innerHTML = payments.map(p => `
        <tr>
          <td>${HZ.formatDate(p.created_at)}</td>
          <td class="strong">${escapeHtml(p.plan ? ('Plan: ' + p.plan) : 'Credits')}</td>
          <td>${HZ.money(p.amount_cents)}</td>
          <td>${(p.credits_added || 0).toLocaleString()}</td>
          <td><span class="tag ${p.status === 'succeeded' ? 'success' : ''}">${escapeHtml(p.status)}</span></td>
        </tr>
      `).join('');
    } catch (ex) {
      tb.innerHTML = `<tr><td colspan="5" class="muted" style="padding:24px">Failed to load: ${ex.message}</td></tr>`;
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
})();
