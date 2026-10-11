/* Sunvai Control Centre — network-wide oversight console. */
(() => {
  'use strict';
  const T = window.Triage;
  // Behind an ngrok free tunnel, API calls must skip ngrok's browser-warning page.
  const _fetch = window.fetch.bind(window);
  const fetch = (url, opts = {}) => _fetch(url, { ...opts, headers: { 'ngrok-skip-browser-warning': '1', ...(opts.headers || {}) } });
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const LEVEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
  const STATUS = { open: 'New', 'in-progress': 'In progress', resolved: 'Resolved' };
  const CHANNELS = { app: 'Mobile app', social: 'Social media', email: 'Email', paper: 'Paper form' };
  const DEPT_ICON = { safety: '🛡️', lifts: '🛗', fare: '🎫', staff: '🧑‍💼', cleanliness: '🧹', general: '📋' };

  const S = {
    token: (() => { try { return sessionStorage.getItem('sunvai.admin') || ''; } catch { return ''; } })(),
    data: null, ok: true, lastLoad: 0,
    ui: { q: '', station: '', dept: '', level: '', status: 'active', escalated: false },
  };

  // ---------- API ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token, ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { signOut(false); throw new Error('Session expired'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  async function load() {
    try {
      S.data = await api('/api/admin/state');
      S.ok = true; S.lastLoad = Date.now();
      T.setCustomTerms(S.data.config.customTerms);
    } catch { S.ok = false; }
    renderShell();
  }

  // ---------- Helpers ----------
  const now = () => S.data?.serverTime || Date.now();
  const active = (r) => r.status !== 'resolved';
  const overdue = (r) => active(r) && r.dueAt && Date.now() > r.dueAt;
  function dur(ms) {
    const m = Math.round(Math.abs(ms) / 60e3);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
  }
  const ago = (t) => (!t ? 'never' : Date.now() - t < 60e3 ? 'just now' : dur(Date.now() - t) + ' ago');
  const fmt = (t) => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const dueLabel = (r) => { if (!active(r) || !r.dueAt) return ''; const d = r.dueAt - Date.now(); return d < 0 ? `Overdue ${dur(d)}` : `Due in ${dur(d)}`; };
  const deptLabel = (d) => T.DEPARTMENTS[d]?.label || d;
  const deviceStatus = (d) => { const age = Date.now() - d.lastSeen; return age < 2 * 60e3 ? ['on', 'Online'] : age < 30 * 60e3 ? ['stale', 'Idle'] : ['', 'Offline']; };
  const records = () => S.data?.records || [];
  const stationsSeen = () => [...new Set(records().map((r) => r.station).filter(Boolean))].sort();

  let toastTimer;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // ---------- Auth ----------
  function showLogin() { $('#login').hidden = false; $('#adminApp').hidden = true; $('#loginForm').password.focus(); }
  async function showApp() {
    $('#login').hidden = true; $('#adminApp').hidden = false;
    if (!location.hash) location.replace('#/overview');
    await load(); renderView();
  }
  function signOut(callServer = true) {
    if (callServer && S.token) fetch('/api/admin/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + S.token } }).catch(() => {});
    S.token = ''; S.data = null;
    try { sessionStorage.removeItem('sunvai.admin'); } catch {}
    if ($('#drawer').open) $('#drawer').close();
    showLogin();
  }
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try {
      const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: e.target.password.value }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sign-in failed');
      S.token = data.token;
      try { sessionStorage.setItem('sunvai.admin', S.token); } catch {}
      e.target.reset();
      showApp();
    } catch (err) {
      $('#loginErr').textContent = err.message === 'Failed to fetch' ? 'Server not reachable' : err.message;
    }
  };
  $('#logout').onclick = () => signOut();

  // ---------- Shell ----------
  function route() {
    const [view = 'overview', a] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    return { view, a };
  }
  function renderShell() {
    const r = route();
    const act = records().filter(active);
    const link = (href, ico, label, count, on) => `<a href="${href}" class="${on ? 'active' : ''}"><span class="ico">${ico}</span>${esc(label)}<span class="cnt">${count ?? ''}</span></a>`;
    const devices = S.data?.devices || [];
    $('#nav').innerHTML = [
      '<div class="sec">Monitor</div>',
      link('#/overview', '◧', 'Network overview', '', r.view === 'overview'),
      link('#/complaints', '☰', 'All complaints', act.length || '', r.view === 'complaints'),
      link('#/escalations', '⚑', 'Escalations', act.filter((x) => x.escalated).length || '', r.view === 'escalations'),
      link('#/stations', '🚉', 'Stations & devices', devices.length || '', r.view === 'stations'),
      '<div class="sec">Administer</div>',
      link('#/policy', '⚙', 'Policy & routing', S.data ? 'v' + S.data.config.version : '', r.view === 'policy'),
      link('#/audit', '🗒', 'Audit log', '', r.view === 'audit'),
    ].join('');
    $('#liveTag').className = 'live' + (S.ok ? '' : ' err');
    $('#liveTag').textContent = S.ok ? 'Live' : 'Server unreachable';
    $('#updatedAt').textContent = S.lastLoad ? 'Updated ' + new Date(S.lastLoad).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  }

  function renderView() {
    if (!S.data) { $('#view').innerHTML = '<div class="empty">Loading…</div>'; return; }
    const r = route();
    const views = { overview: viewOverview, complaints: () => viewComplaints(false), escalations: () => viewComplaints(true), stations: viewStations, policy: viewPolicy, audit: viewAudit };
    (views[r.view] || viewOverview)();
  }
  window.addEventListener('hashchange', () => { closeMenu(); renderShell(); renderView(); window.scrollTo(0, 0); });

  // ---------- Overview ----------
  function viewOverview() {
    const all = records();
    const act = all.filter(active);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const devices = S.data.devices;
    const online = devices.filter((d) => deviceStatus(d)[0] === 'on').length;
    const acked = all.filter((r) => r.ackAt);
    const avgAck = acked.length ? acked.reduce((s, r) => s + (r.ackAt - r.receivedAt), 0) / acked.length : null;

    const byStation = {};
    for (const r of all) {
      const k = r.station || 'Not stated';
      const s = (byStation[k] ||= { total: 0, active: 0, crit: 0, overdue: 0, esc: 0 });
      s.total++;
      if (active(r)) { s.active++; if (r.level === 'critical') s.crit++; if (overdue(r)) s.overdue++; if (r.escalated) s.esc++; }
    }
    const stations = Object.entries(byStation).sort((a, b) => b[1].crit - a[1].crit || b[1].overdue - a[1].overdue || b[1].active - a[1].active);
    const deptRows = T.DEPT_ORDER.map((d) => [d, act.filter((r) => r.dept === d).length]);
    const maxDept = Math.max(1, ...deptRows.map((x) => x[1]));
    const attention = act.filter((r) => r.level === 'critical' || overdue(r) || r.escalated)
      .sort((a, b) => (b.escalated - a.escalated) || (overdue(b) - overdue(a)) || b.urgency - a.urgency).slice(0, 8);

    if (!all.length) {
      $('#view').innerHTML = `<div class="page-head"><div><h1>Network overview</h1><p class="muted">All stations</p></div></div>
        <div class="card"><div class="empty"><h3>No complaints received yet</h3><p>Complaints appear here as station devices sync. ${devices.length} device(s) have connected so far.</p></div></div>`;
      return;
    }

    $('#view').innerHTML = `
      <div class="page-head"><div><h1>Network overview</h1><p class="muted">${stations.length} station(s) · ${devices.length} device(s), ${online} online now</p></div>
        <a class="btn" href="#/complaints">View all complaints</a></div>
      <div class="tiles">
        <a class="card tile" href="#/complaints"><div class="k">Active complaints</div><div class="v">${act.length}</div><div class="s">${all.length} received in total</div></a>
        <a class="card tile ${act.some((r) => r.level === 'critical') ? 'alert' : ''}" href="#/complaints" data-filter="level:critical"><div class="k">Critical</div><div class="v">${act.filter((r) => r.level === 'critical').length}</div><div class="s">Across all stations</div></a>
        <a class="card tile ${act.some(overdue) ? 'alert' : ''}" href="#/complaints" data-filter="overdue"><div class="k">Past response target</div><div class="v">${act.filter(overdue).length}</div><div class="s">Need follow-up</div></a>
        <a class="card tile" href="#/escalations"><div class="k">Escalated</div><div class="v">${act.filter((r) => r.escalated).length}</div><div class="s">Under control-centre watch</div></a>
        <div class="card tile"><div class="k">Resolved today</div><div class="v">${all.filter((r) => r.resolvedAt >= today.getTime()).length}</div><div class="s">${avgAck != null ? 'Avg. acknowledgement ' + dur(avgAck) : 'No acknowledgements yet'}</div></div>
      </div>
      <div class="dash">
        <div class="stack">
          <div class="card">
            <div class="card-h"><h2>Needs control-centre attention</h2><span class="muted small">Critical, overdue or escalated</span></div>
            ${attention.length ? `<ul class="list">${attention.map((r) => `<li><a class="attn" href="#" data-open="${esc(r.id)}">
              <span class="badge ${r.level}">${r.urgency}</span>
              <div class="t"><div><strong>${esc(r.station || 'Station not stated')}</strong> · ${esc(deptLabel(r.dept))} ${r.escalated ? '<span class="chip overdue">Escalated</span>' : ''}</div><div class="muted small">${esc(r.text)}</div></div>
              <span class="chip ${overdue(r) ? 'overdue' : ''}">${dueLabel(r)}</span></a></li>`).join('')}</ul>` : '<div class="empty small">Nothing needs escalation right now.</div>'}
          </div>
          <div class="card">
            <div class="card-h"><h2>Stations</h2><span class="muted small">Sorted by risk</span></div>
            <div class="card-b flush" style="overflow-x:auto"><table class="tbl"><thead><tr><th>Station</th><th class="num">Active</th><th class="num">Critical</th><th class="num">Overdue</th><th class="num">Escalated</th><th class="num">Total</th></tr></thead><tbody>
              ${stations.map(([s, v]) => `<tr class="click" data-station="${esc(s)}"><td>${esc(s)}</td><td class="num">${v.active}</td>
                <td class="num">${v.crit ? `<span class="badge critical">${v.crit}</span>` : '—'}</td><td class="num">${v.overdue ? `<span class="badge high">${v.overdue}</span>` : '—'}</td>
                <td class="num">${v.esc || '—'}</td><td class="num">${v.total}</td></tr>`).join('')}
            </tbody></table></div>
          </div>
        </div>
        <div class="stack">
          <div class="card"><div class="card-h"><h2>Active by department</h2></div><div class="card-b"><div class="bars">
            ${deptRows.map(([d, n]) => `<div class="bar-row"><a href="#/complaints" data-filter="dept:${d}">${esc(deptLabel(d))}</a><div class="bar"><span style="width:${(n / maxDept) * 100}%"></span></div><span class="n">${n}</span></div>`).join('')}
          </div></div></div>
          <div class="card"><div class="card-h"><h2>Devices</h2><a class="small" href="#/stations">Manage →</a></div>
            <ul class="list">${devices.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 6).map((d) => { const [cls, lbl] = deviceStatus(d); return `<li class="attn"><div class="t"><div><span class="online-dot ${cls}"></span><strong>${esc(d.station || 'Unassigned')}</strong> · ${esc(d.name || d.device)}</div><div class="muted small">${lbl} · last seen ${ago(d.lastSeen)}</div></div></li>`; }).join('') || '<li class="empty small">No devices yet</li>'}</ul>
          </div>
        </div>
      </div>`;
    bindCommon();
  }

  function bindCommon() {
    $$('[data-open]').forEach((el) => (el.onclick = (e) => { e.preventDefault(); openDrawer(el.dataset.open); }));
    $$('[data-station]').forEach((el) => (el.onclick = () => { resetFilters(); S.ui.station = el.dataset.station === 'Not stated' ? '' : el.dataset.station; location.hash = '#/complaints'; }));
    $$('[data-filter]').forEach((el) => (el.onclick = () => {
      resetFilters();
      const [k, v] = el.dataset.filter.split(':');
      if (k === 'overdue') S.ui.status = 'overdue'; else S.ui[k] = v;
    }));
  }
  function resetFilters() { Object.assign(S.ui, { q: '', station: '', dept: '', level: '', status: 'active', escalated: false }); $('#globalSearch').value = ''; }

  // ---------- Complaints ----------
  function filtered(escalatedOnly) {
    const u = S.ui; const q = u.q.trim().toLowerCase();
    return records().filter((r) =>
      (!escalatedOnly || (r.escalated && active(r))) &&
      (!u.escalated || r.escalated) &&
      (!u.station || r.station === u.station) && (!u.dept || r.dept === u.dept) && (!u.level || r.level === u.level) &&
      (u.status === 'all' || (u.status === 'active' ? active(r) : u.status === 'overdue' ? overdue(r) : r.status === u.status)) &&
      (!q || [r.text, r.station, r.id, deptLabel(r.dept), r.device].join(' ').toLowerCase().includes(q))
    ).sort((a, b) => (b.escalated - a.escalated) || b.urgency - a.urgency || b.receivedAt - a.receivedAt);
  }

  function viewComplaints(escalatedOnly) {
    const list = filtered(escalatedOnly);
    const u = S.ui;
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>${escalatedOnly ? 'Escalations' : 'All complaints'}</h1><p class="muted">${list.length} shown${escalatedOnly ? ' · active complaints the control centre is watching' : ' · across all stations'}</p></div>
        ${escalatedOnly ? '' : '<button class="btn" id="exportCsv">Export CSV</button>'}</div>
      <div class="card">
        <div class="filter-bar">
          <select id="fStation">${opt('', 'All stations', u.station)}${stationsSeen().map((s) => opt(s, s, u.station)).join('')}</select>
          <select id="fDept">${opt('', 'All departments', u.dept)}${T.DEPT_ORDER.map((d) => opt(d, deptLabel(d), u.dept)).join('')}</select>
          <select id="fLevel">${opt('', 'All urgency', u.level)}${Object.entries(LEVEL).map(([k, v]) => opt(k, v, u.level)).join('')}</select>
          ${escalatedOnly ? '' : `<select id="fStatus">${[['active', 'Active'], ['overdue', 'Overdue'], ['open', 'New'], ['in-progress', 'In progress'], ['resolved', 'Resolved'], ['all', 'All statuses']].map(([k, v]) => opt(k, v, u.status)).join('')}</select>
          <label class="switch"><input type="checkbox" id="fEsc" ${u.escalated ? 'checked' : ''}> Escalated only</label>`}
          <span class="spacer"></span>
          ${u.q ? `<span class="chip">Search: ${esc(u.q)}</span>` : ''}
          <button class="btn btn-sm" id="fReset">Reset</button>
        </div>
        <div class="card-b flush" style="overflow-x:auto">
          ${list.length ? `<table class="tbl"><thead><tr><th>Urgency</th><th>Reference</th><th>Station</th><th>Department</th><th>Complaint</th><th>Language</th><th>Status</th><th>Due</th><th>Received</th></tr></thead><tbody>
            ${list.map((r) => `<tr class="click" data-open="${esc(r.id)}">
              <td><span class="badge ${r.level}">${LEVEL[r.level]} ${r.urgency}</span></td>
              <td>${esc(r.id)}${r.escalated ? ' <span class="chip overdue">Esc.</span>' : ''}</td>
              <td>${esc(r.station || '—')}</td><td>${esc(deptLabel(r.dept))}</td>
              <td class="clip" title="${esc(r.text)}">${esc(r.text)}</td>
              <td>${esc(T.LANGS[r.lang] || r.lang)}</td>
              <td><span class="status ${r.status}">${STATUS[r.status]}</span></td>
              <td>${active(r) ? `<span class="chip ${overdue(r) ? 'overdue' : ''}">${dueLabel(r)}</span>` : '—'}</td>
              <td class="muted">${ago(r.receivedAt)}</td></tr>`).join('')}
          </tbody></table>` : '<div class="empty"><h3>No complaints match</h3><p>Try clearing the filters.</p></div>'}
        </div>
      </div>`;
    const set = (id, key) => { const el = $(id); if (el) el.onchange = (e) => { S.ui[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; renderView(); }; };
    set('#fStation', 'station'); set('#fDept', 'dept'); set('#fLevel', 'level'); set('#fStatus', 'status'); set('#fEsc', 'escalated');
    $('#fReset').onclick = () => { resetFilters(); renderView(); };
    const ex = $('#exportCsv'); if (ex) ex.onclick = () => exportCsv(list);
    $$('tr[data-open]').forEach((tr) => (tr.onclick = () => openDrawer(tr.dataset.open)));
  }

  function exportCsv(list) {
    const cols = ['id', 'received', 'station', 'department', 'urgency', 'level', 'status', 'escalated', 'language', 'channel', 'device', 'complaint'];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = list.map((r) => [r.id, new Date(r.receivedAt).toISOString(), r.station, deptLabel(r.dept), r.urgency, r.level, r.status, r.escalated ? 'yes' : 'no', T.LANGS[r.lang], r.channel, r.device, r.text].map(q).join(','));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + [cols.join(','), ...rows].join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `sunvai-network-complaints-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Complaint drawer ----------
  function openDrawer(id) {
    const r = records().find((x) => x.id === id); if (!r) return;
    const d = $('#drawer');
    const dev = S.data.devices.find((x) => x.device === r.device);
    d.innerHTML = `
      <div class="drawer-h">
        <div>
          <h2>${esc(deptLabel(r.dept))} <span class="badge ${r.level}">${LEVEL[r.level]} · ${r.urgency}</span> ${r.escalated ? '<span class="chip overdue">Escalated</span>' : ''}</h2>
          <div class="muted small" style="margin-top:4px">${esc(r.id)} · <span class="status ${r.status}">${STATUS[r.status]}</span>${active(r) ? ' · ' + dueLabel(r) : ''}</div>
        </div>
        <button class="icon-btn" id="dClose" aria-label="Close">✕</button>
      </div>
      <div class="drawer-b">
        <div class="message">
          <div class="mh">${esc(CHANNELS[r.channel] || r.channel)} · ${esc(T.LANGS[r.lang] || r.lang)} · ${fmt(r.receivedAt)} · ${esc(r.station || 'Station not stated')}</div>
          <div class="mb">${esc(r.text)}</div>
        </div>
        <dl class="facts">
          <dt>Handled by</dt><dd>${esc(dev?.name || '—')} · ${esc(dev?.station || '')} (${esc(r.device)})</dd>
          <dt>Acknowledged</dt><dd>${fmt(r.ackAt)}</dd>
          <dt>Reply sent</dt><dd>${r.replySentAt ? fmt(r.replySentAt) : 'Not yet'}</dd>
          <dt>Urgency factors</dt><dd style="font-weight:normal">${(r.signals || []).map((s) => `${esc(s.label)} (+${s.pts})`).join(', ') || '—'}</dd>
        </dl>
        ${r.reply ? `<div><div class="section-t">Reply drafted at station</div><div class="reply-box">${esc(r.reply)}</div></div>` : ''}
        <div class="card"><div class="card-b" style="display:flex;flex-direction:column;gap:12px">
          <div class="section-t" style="margin:0">Control-centre action</div>
          <div class="form-grid">
            <label>Department<select id="aDept">${T.DEPT_ORDER.map((x) => `<option value="${x}" ${x === r.dept ? 'selected' : ''}>${esc(deptLabel(x))}</option>`).join('')}</select></label>
            <label>Status<select id="aStatus">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          </div>
          <label class="switch"><input type="checkbox" id="aEsc" ${r.escalated ? 'checked' : ''}> Escalate (flag to station and keep under watch)</label>
          <label>Instruction or note to station<textarea id="aNote" rows="3" placeholder="e.g. Send the RPF team; call the passenger back within 1 hour."></textarea></label>
          <div class="row" style="justify-content:flex-end"><button class="btn btn-primary" id="aSave">Save &amp; send to station</button></div>
          <p class="small muted" style="margin:0">The station device receives this on its next sync (about every 15 seconds while online).</p>
        </div></div>
        <div>
          <div class="section-t">Activity</div>
          <ul class="timeline">${(r.history || []).slice().reverse().map((h) => `<li class="${h.type === 'note' ? 'note' : ''}">
            <div>${h.type === 'note' ? `<strong>${esc(h.by || 'Note')}</strong>${h.hq ? ' <span class="chip">Control centre</span>' : ''}` : esc(h.text)}</div>
            ${h.type === 'note' ? `<div class="note-body">${esc(h.text)}</div>` : ''}
            <div class="when">${fmt(h.at)}${h.by && h.type !== 'note' ? ' · ' + esc(h.by) : ''}</div></li>`).join('')}</ul>
        </div>
      </div>`;
    $('#dClose').onclick = () => d.close();
    $('#aSave').onclick = async () => {
      const body = { dept: $('#aDept').value, status: $('#aStatus').value, escalated: $('#aEsc').checked, note: $('#aNote').value, actor: 'Control centre' };
      $('#aSave').disabled = true;
      try {
        await api(`/api/admin/complaints/${encodeURIComponent(r.id)}`, { method: 'PATCH', body });
        await load(); renderView(); openDrawer(r.id);
        toast('Saved. The station will receive it on its next sync.');
      } catch (e) { toast('Could not save: ' + e.message); $('#aSave').disabled = false; }
    };
    if (!d.open) d.showModal();
  }
  $('#drawer').addEventListener('click', (e) => { if (e.target === $('#drawer')) $('#drawer').close(); });

  // ---------- Stations & devices ----------
  function viewStations() {
    const devs = S.data.devices.slice().sort((a, b) => b.lastSeen - a.lastSeen);
    const count = (dev) => records().filter((r) => r.device === dev.device);
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>Stations &amp; devices</h1><p class="muted">Every desk or tablet that has synced with the control centre.</p></div></div>
      <div class="card"><div class="card-b flush" style="overflow-x:auto">
        ${devs.length ? `<table class="tbl"><thead><tr><th>Status</th><th>Station</th><th>Controller</th><th>Device</th><th class="num">Active</th><th class="num">Total</th><th>Last seen</th><th>Last upload</th></tr></thead><tbody>
          ${devs.map((d) => { const [cls, lbl] = deviceStatus(d); const rs = count(d); return `<tr class="click" data-station="${esc(d.station || 'Not stated')}">
            <td><span class="online-dot ${cls}"></span>${lbl}</td><td><strong>${esc(d.station || 'Unassigned')}</strong></td><td>${esc(d.name || '—')}</td><td class="muted">${esc(d.device)}</td>
            <td class="num">${rs.filter(active).length}</td><td class="num">${rs.length}</td><td>${ago(d.lastSeen)}</td><td>${ago(d.lastPush)}</td></tr>`; }).join('')}
        </tbody></table>` : '<div class="empty"><h3>No devices yet</h3><p>Devices appear here after their first sync.</p></div>'}
      </div></div>
      <p class="small muted">Online means the device synced in the last 2 minutes. Devices keep working offline and upload when they reconnect.</p>`;
    bindCommon();
  }

  // ---------- Policy ----------
  function viewPolicy() {
    const c = S.data.config;
    const levels = ['critical', 'high', 'medium', 'low'];
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>Policy &amp; routing</h1><p class="muted">Published to every station device on its next sync. Current version v${c.version}${c.updatedAt ? ', published ' + ago(c.updatedAt) : ''}.</p></div></div>
      <div class="settings" style="max-width:1000px">
        <form class="card" id="policyForm">
          <div class="card-h"><h2>Response targets</h2><span class="muted small">Minutes from receipt to first response</span></div>
          <div class="card-b sla-grid">${levels.map((l) => `<label><span><span class="badge ${l}">${LEVEL[l]}</span></span><input type="number" min="1" max="43200" name="sla_${l}" value="${c.slaMinutes[l]}" required></label>`).join('')}</div>
          <div class="card-h" style="border-top:1px solid var(--border)"><h2>Extra routing keywords</h2><span class="muted small">Comma-separated. Any script: English, ગુજરાતી, हिन्दी, romanized.</span></div>
          <div class="card-b kw-grid">${T.DEPT_ORDER.map((d) => `<label>${DEPT_ICON[d]} ${esc(deptLabel(d))}<textarea name="kw_${d}" rows="2" placeholder="e.g. ${d === 'safety' ? 'rpf, ભય' : d === 'fare' ? 'smart card, ભાડા' : d === 'lifts' ? 'travelator' : 'keyword'}">${esc((c.customTerms[d] || []).join(', '))}</textarea></label>`).join('')}</div>
          <div class="card-b row" style="justify-content:flex-end;border-top:1px solid var(--border)"><button class="btn btn-primary">Publish policy</button></div>
        </form>
        <div class="card">
          <div class="card-h"><h2>Test routing</h2><span class="muted small">Uses the keywords above before you publish</span></div>
          <div class="card-b"><textarea id="testText" rows="3" placeholder="Paste a sample complaint…"></textarea><div id="testOut" style="margin-top:10px"></div></div>
        </div>
        <div class="card">
          <div class="card-h"><h2>Danger zone</h2></div>
          <div class="set-row"><div><div>Reset control-centre data</div><div class="d">Delete all received complaints, device records and sync history. Policy is kept. Station devices keep their own copies.</div></div>
            <button class="btn btn-danger" id="resetAll">Reset data</button></div>
        </div>
      </div>`;
    const form = $('#policyForm');
    const draftTerms = () => Object.fromEntries(T.DEPT_ORDER.map((d) => [d, form['kw_' + d].value.split(',').map((t) => t.trim()).filter(Boolean)]));
    const test = () => {
      const text = $('#testText').value.trim();
      if (!text) { $('#testOut').innerHTML = ''; return; }
      T.setCustomTerms(draftTerms());
      const r = T.classify(text);
      T.setCustomTerms(S.data.config.customTerms);
      $('#testOut').innerHTML = `<div class="row"><strong>${DEPT_ICON[r.dept]} ${esc(deptLabel(r.dept))}</strong><span class="badge ${r.level}">${LEVEL[r.level]} ${r.urgency}</span><span class="chip">${esc(T.LANGS[r.lang])}</span><span class="chip">${esc(r.station || 'No station')}</span><span class="muted small">confidence ${Math.round(r.confidence * 100)}%</span></div>`;
    };
    $('#testText').oninput = test;
    form.oninput = test;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const slaMinutes = Object.fromEntries(levels.map((l) => [l, Number(form['sla_' + l].value)]));
      try {
        const cfg = await api('/api/admin/config', { method: 'PUT', body: { slaMinutes, customTerms: draftTerms() } });
        await load(); renderView();
        toast(`Policy v${cfg.version} published. Devices pick it up on their next sync.`);
      } catch (err) { toast('Could not publish: ' + err.message); }
    };
    $('#resetAll').onclick = async () => {
      if (!confirm('Delete all complaints and device records held by the control centre?')) return;
      try { await api('/api/admin/reset', { method: 'POST' }); await load(); renderView(); toast('Control-centre data cleared'); }
      catch (err) { toast(err.message); }
    };
  }

  // ---------- Audit ----------
  function viewAudit() {
    const devName = (id) => { const d = S.data.devices.find((x) => x.device === id); return d ? `${d.name || id} (${d.station || 'unassigned'})` : id; };
    const rows = [
      ...S.data.audit.map((a) => ({ at: a.at, who: a.actor, what: a.action, detail: a.detail })),
      ...S.data.syncs.map((s) => ({ at: s.at, who: devName(s.device), what: 'sync', detail: `Uploaded ${s.count} record(s)` })),
    ].sort((a, b) => b.at - a.at).slice(0, 300);
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>Audit log</h1><p class="muted">Sign-ins, control-centre actions, policy changes and device uploads.</p></div></div>
      <div class="card"><div class="card-b flush" style="overflow-x:auto">
        ${rows.length ? `<table class="tbl"><thead><tr><th>When</th><th>Who</th><th>Event</th><th>Detail</th></tr></thead><tbody>
          ${rows.map((r) => `<tr><td class="muted" style="white-space:nowrap">${fmt(r.at)}</td><td>${esc(r.who)}</td><td><span class="chip">${esc(r.what)}</span></td><td>${esc(r.detail)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No activity yet.</div>'}
      </div></div>`;
  }

  // ---------- Wiring ----------
  $('#searchForm').onsubmit = (e) => {
    e.preventDefault();
    S.ui.q = $('#globalSearch').value; S.ui.status = 'all';
    if (route().view !== 'complaints') location.hash = '#/complaints'; else renderView();
  };
  $('#refresh').onclick = async () => { await load(); renderView(); };
  const closeMenu = () => { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); };
  $('#menuBtn').onclick = () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); };
  $('#scrim').onclick = closeMenu;

  // Live refresh; skip re-rendering while the admin is editing (drawer open or typing in a form).
  setInterval(async () => {
    if (!S.token || $('#adminApp').hidden) return;
    await load();
    const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.activeElement.id !== 'globalSearch';
    if (!$('#drawer').open && !typing && route().view !== 'policy') renderView();
  }, 10000);

  if (S.token) showApp(); else showLogin();
})();
