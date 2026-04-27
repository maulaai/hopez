/* admin.js — pool console for role=admin */
(function () {
  'use strict';

  const showTab = (name) => {
    document.querySelectorAll('.sidebar a[data-tab]').forEach(a =>
      a.classList.toggle('active', a.dataset.tab === name));
    document.querySelectorAll('section[data-pane]').forEach(s =>
      s.classList.toggle('hidden', s.dataset.pane !== name));
    if (history.replaceState) history.replaceState(null, '', '#' + name);
  };
  document.querySelectorAll('.sidebar a[data-tab]').forEach(a =>
    a.addEventListener('click', e => { e.preventDefault(); showTab(a.dataset.tab); }));

  function escapeHtml(s) { return (s ?? '').toString().replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  (async function boot() {
    let me;
    try { me = await HZ.requireAuth(); } catch { return; }
    if (me.user.role !== 'admin') {
      document.body.innerHTML = '<div style="padding:60px;text-align:center"><h1>Admin only</h1><p><a href="/dashboard">Return to console</a></p></div>';
      return;
    }
    const hash = (location.hash || '').replace('#','');
    if (hash) showTab(hash);
    await refreshPool();
    document.getElementById('poolFilter').onchange = refreshPool;
    document.getElementById('importBtn').onclick = doImport;
    await refreshBindings();
  })();

  async function refreshPool() {
    try {
      const overview = await api('/api/admin/pool');
      const s = overview.stats;
      const wrap = document.getElementById('poolStats');
      wrap.innerHTML = [
        ['Total', s.total],
        ['Available', s.available],
        ['Assigned', s.assigned],
        ['Cooling down', s.cooling_down],
        ['Revoked', s.revoked],
        ['Exhausted', s.exhausted]
      ].map(([k, v]) => `
        <div class="card"><div class="muted" style="font-size:12px">${k.toUpperCase()}</div>
        <div style="font-size:26px;font-weight:600">${v}</div></div>
      `).join('');

      const filter = document.getElementById('poolFilter').value;
      const q = filter ? '?status=' + encodeURIComponent(filter) : '';
      const list = await api('/api/admin/pool/keys' + q);
      const tbody = document.getElementById('poolBody');
      if (!list.keys.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="muted" style="padding:24px;text-align:center">No keys.</td></tr>`;
        return;
      }
      tbody.innerHTML = list.keys.map(k => `
        <tr>
          <td>#${k.id}</td>
          <td><code>${escapeHtml(k.label || '')}</code></td>
          <td><span class="tag">${escapeHtml(k.status)}</span></td>
          <td>${k.assigned_to ? 'api_keys#' + k.assigned_to : '<span class="muted">—</span>'}</td>
          <td>${k.request_count}</td>
          <td>${k.last_used_at ? HZ.formatDate(k.last_used_at) : '<span class="muted">Never</span>'}</td>
          <td style="text-align:right">
            ${k.status === 'revoked' ? '' :
              `<button class="btn sm danger" data-revoke="${k.id}">Revoke</button>`}
          </td>
        </tr>
      `).join('');
      tbody.querySelectorAll('[data-revoke]').forEach(b => {
        b.onclick = async () => {
          if (!confirm('Revoke this upstream key? Any bound frontend key will also be revoked.')) return;
          try { await api('/api/admin/pool/' + b.dataset.revoke + '/revoke', { method: 'POST', body: { reason: 'admin_console' } });
            HZ.toast('Revoked', 'success'); await refreshPool();
          } catch (e) { HZ.toast(e.message, 'danger'); }
        };
      });
    } catch (e) {
      document.getElementById('poolBody').innerHTML =
        `<tr><td colspan="7" class="muted" style="padding:24px">Failed: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function refreshBindings() {
    try {
      const { bindings } = await api('/api/admin/bindings?limit=200');
      const tb = document.getElementById('bindingsBody');
      if (!bindings.length) {
        tb.innerHTML = `<tr><td colspan="5" class="muted" style="padding:24px;text-align:center">No events yet.</td></tr>`;
        return;
      }
      tb.innerHTML = bindings.map(b => `
        <tr>
          <td>${HZ.formatDate(b.created_at)}</td>
          <td><span class="tag">${escapeHtml(b.action)}</span></td>
          <td>api_keys#${b.api_key_id}</td>
          <td>backend_keys#${b.backend_key_id}</td>
          <td>${escapeHtml(b.reason || '')}</td>
        </tr>`).join('');
    } catch (e) {
      document.getElementById('bindingsBody').innerHTML =
        `<tr><td colspan="5" class="muted" style="padding:24px">Failed: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function doImport() {
    const status = document.getElementById('importStatus');
    status.textContent = '';
    let parsed;
    try { parsed = JSON.parse(document.getElementById('importJson').value); }
    catch { status.textContent = 'Invalid JSON'; return; }
    try {
      const r = await api('/api/admin/pool/import', { method: 'POST', body: { keys: parsed } });
      status.textContent = `Added ${r.added}, dedup ${r.dedup}`;
      document.getElementById('importJson').value = '';
      await refreshPool();
    } catch (e) { status.textContent = 'Failed: ' + e.message; }
  }
})();
