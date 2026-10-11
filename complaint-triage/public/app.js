/* Sunvai — passenger grievance desk. Offline-first single-page app. */
(() => {
  'use strict';
  const T = window.Triage;
  // Behind an ngrok free tunnel, API calls must skip ngrok's browser-warning page.
  const _fetch = window.fetch.bind(window);
  const fetch = (url, opts = {}) => _fetch(url, { ...opts, headers: { 'ngrok-skip-browser-warning': '1', ...(opts.headers || {}) } });
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Persistence ----------
  const KEY = { complaints: 'ech.complaints', outbox: 'ech.outbox', settings: 'ech.settings', learned: 'ech.learned', log: 'ech.synclog', device: 'ech.device' };
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Could not save on this device: ' + e.message); } };

  const state = {
    complaints: load(KEY.complaints, []),
    outbox: load(KEY.outbox, {}),
    settings: load(KEY.settings, {}),
    learned: load(KEY.learned, {}),
    log: load(KEY.log, []),
    device: load(KEY.device, null),
    llm: { available: false, models: [] },
    server: null,
    syncing: false,
  };
  if (!state.device) { state.device = 'DSK-' + Math.random().toString(36).slice(2, 7).toUpperCase(); save(KEY.device, state.device); }
  if ('forceOffline' in state.settings) { state.settings.offline = state.settings.forceOffline; delete state.settings.forceOffline; }

  const ui = { q: '', status: 'active', sort: 'urgency', lang: '' };

  // Response targets and extra routing keywords come from the control-centre policy (cached for offline use).
  const DEFAULT_SLA_MIN = { critical: 15, high: 240, medium: 1440, low: 4320 };
  let SLA_MS = {};
  function applyPolicy(policy) {
    const min = { ...DEFAULT_SLA_MIN, ...(policy?.slaMinutes || {}) };
    SLA_MS = Object.fromEntries(Object.entries(min).map(([k, v]) => [k, v * 60e3]));
    T.setCustomTerms(policy?.customTerms || {});
  }
  applyPolicy(state.settings.policy);
  const slaLabel = (level) => { const m = SLA_MS[level] / 60e3; return m < 60 ? `${m} min` : m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}` : `${+(m / 60).toFixed(1)} h`; };
  const CHANNELS = { app: 'Mobile app', social: 'Social media', email: 'Email', paper: 'Paper form' };
  const CH_ICON = { app: '📱', social: '💬', email: '✉️', paper: '📝' };
  const LEVEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
  const LEVEL_COLOR = { critical: 'var(--critical)', high: 'var(--high)', medium: 'var(--medium)', low: 'var(--low)' };
  const STATUS = { open: 'New', 'in-progress': 'In progress', resolved: 'Resolved' };
  const DEPT_ICON = { safety: '🛡️', lifts: '🛗', fare: '🎫', staff: '🧑‍💼', cleanliness: '🧹', general: '📋' };

  // Older records: fill in fields added later.
  for (const c of state.complaints) {
    c.history ||= [{ at: c.receivedAt, type: 'received', text: `Received via ${CHANNELS[c.channel] || c.channel}` }];
    c.dueAt ||= c.receivedAt + SLA_MS[c.level];
  }

  const persist = () => { save(KEY.complaints, state.complaints); save(KEY.outbox, state.outbox); };
  const saveSettings = () => save(KEY.settings, state.settings);
  const byId = (id) => state.complaints.find((c) => c.id === id);
  const active = (c) => c.status !== 'resolved';
  const overdue = (c, now = Date.now()) => active(c) && now > c.dueAt;

  // ---------- Time helpers ----------
  function dur(ms) {
    const m = Math.round(Math.abs(ms) / 60e3);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h${m % 60 && h < 6 ? ' ' + (m % 60) + 'm' : ''}`;
    return `${Math.floor(h / 24)}d`;
  }
  const ago = (t) => { const d = Date.now() - t; return d < 60e3 ? 'just now' : dur(d) + ' ago'; };
  const dueLabel = (c) => { const d = c.dueAt - Date.now(); return d < 0 ? `Overdue ${dur(d)}` : `Due in ${dur(d)}`; };
  const fmt = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  // ---------- Complaint lifecycle ----------
  function newId() {
    const d = new Date();
    const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `GM${ymd}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  }

  function triage({ text, channel = 'app', name = '', contact = '', station = '', receivedAt = Date.now() }) {
    const r = T.classify(text, { channel, learned: state.learned });
    const c = {
      id: newId(), text: text.trim(), channel, receivedAt, passenger: { name, contact },
      ...r, station: station || r.station, baseUrgency: r.urgency, status: 'open',
      overridden: false, aiRefined: false, replyLang: r.lang, updatedAt: Date.now(), device: state.device,
    };
    c.dueAt = receivedAt + SLA_MS[c.level];
    c.reply = T.draftReply(c);
    c.history = [
      { at: receivedAt, type: 'received', text: `Received via ${CHANNELS[channel] || channel}` },
      { at: Date.now(), type: 'triaged', text: `Routed to ${T.DEPARTMENTS[c.dept].label} · ${LEVEL[c.level]} (${c.urgency}) · ${T.LANGS[c.lang]}` },
    ];
    return c;
  }

  // Several active reports about the same station + department reinforce each other.
  function applyCorroboration() {
    const groups = {};
    for (const c of state.complaints) if (active(c) && c.station) (groups[c.station + '|' + c.dept] ||= []).push(c);
    for (const c of state.complaints) {
      const n = active(c) && c.station ? groups[c.station + '|' + c.dept].length : 1;
      const bonus = Math.min(15, 5 * (n - 1));
      c.signals = c.signals.filter((s) => s.id !== 'corroboration');
      if (bonus) c.signals.push({ id: 'corroboration', label: `${n} active reports for this station & issue`, pts: bonus });
      const next = Math.min(100, c.baseUrgency + bonus);
      if (next !== c.urgency) {
        c.urgency = next; c.level = T.levelFor(next); c.dueAt = c.receivedAt + SLA_MS[c.level];
        if (!c.replyEdited && !c.aiRefined) c.reply = T.draftReply(c, c.replyLang);
      }
    }
  }

  function addComplaints(items) {
    const t0 = performance.now();
    const created = items.filter((i) => i.text && i.text.trim()).map(triage);
    const ms = performance.now() - t0;
    state.complaints.push(...created);
    for (const c of created) state.outbox[c.id] = c.updatedAt;
    applyCorroboration(); persist(); refresh(); trySync();
    return { created, ms };
  }

  function update(id, patch, event) {
    const c = byId(id); if (!c) return;
    Object.assign(c, patch);
    if (event) c.history.push({ at: Date.now(), by: state.settings.profile?.name, ...event });
    c.updatedAt = Date.now();
    state.outbox[c.id] = c.updatedAt;
    applyCorroboration(); persist(); refresh(); trySync();
  }

  // ---------- Network & sync ----------
  const isOnline = () => navigator.onLine && !state.settings.offline;

  async function trySync(manual = false) {
    if (state.syncing) return;
    const ids = Object.keys(state.outbox);
    if (!isOnline()) { if (manual) toast(`You're offline. ${ids.length} update(s) will be sent when you reconnect.`); renderShell(); return; }
    state.syncing = ids.length > 0; renderShell();
    const records = ids.map(byId).filter(Boolean).map(({ deptScores, matched, ...rest }) => rest);
    try {
      const res = await fetch('/api/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: state.device, profile: state.settings.profile, records, since: state.settings.lastPull || 0 }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const { accepted, updates = [], config, serverTime } = await res.json();
      for (const a of accepted) if (state.outbox[a.id] !== undefined && state.outbox[a.id] <= a.updatedAt) delete state.outbox[a.id];
      for (const id of Object.keys(state.outbox)) if (!byId(id)) delete state.outbox[id];
      const pulled = mergeUpdates(updates);
      const policyChanged = config && config.version !== state.settings.policy?.version;
      if (policyChanged) {
        state.settings.policy = config; applyPolicy(config);
        for (const c of state.complaints) c.dueAt = c.receivedAt + SLA_MS[c.level];
        addLog(`Received control-centre policy v${config.version}`);
      }
      persist();
      state.server = true;
      state.settings.lastSync = Date.now(); state.settings.lastPull = serverTime || state.settings.lastPull; saveSettings();
      if (accepted.length) addLog(`Sent ${accepted.length} update(s) to the control centre`);
      if (pulled) { addLog(`Received ${pulled} update(s) from the control centre`); toast(`${pulled} complaint(s) updated by the control centre`); }
      if (pulled || policyChanged) renderView();
      if (manual && !pulled) toast(accepted.length ? `Synced ${accepted.length} update(s)` : 'Everything is up to date');
    } catch (e) {
      state.server = false;
      addLog(`Sync failed (${e.message}); will retry`);
      if (manual) toast("Can't reach the control centre. Your updates are safe on this device.");
    } finally {
      state.syncing = false; renderShell();
      if (route().view === 'settings') renderSettingsStatus();
    }
  }

  // Control-centre edits: take the whole record if it is newer, otherwise fold in its notes and escalation.
  function mergeUpdates(updates) {
    let n = 0;
    for (const u of updates) {
      const local = byId(u.id);
      if (!local) continue;
      if ((u.hqUpdatedAt || 0) <= (local.hqUpdatedAt || 0)) continue;
      if (u.updatedAt > local.updatedAt) {
        Object.assign(local, u, { device: state.device });
        delete state.outbox[u.id];
      } else {
        const seen = new Set(local.history.map((h) => `${h.at}|${h.type}|${h.text}`));
        local.history.push(...(u.history || []).filter((h) => !seen.has(`${h.at}|${h.type}|${h.text}`)));
        local.history.sort((a, b) => a.at - b.at);
        local.escalated = u.escalated;
        local.hqUpdatedAt = u.hqUpdatedAt;
      }
      n++;
    }
    return n;
  }

  function addLog(msg) {
    state.log.unshift({ at: Date.now(), msg });
    state.log = state.log.slice(0, 40);
    save(KEY.log, state.log);
  }

  window.addEventListener('online', () => { renderShell(); trySync(); checkLlm(); });
  window.addEventListener('offline', renderShell);
  setInterval(() => trySync(), 15000);
  setInterval(() => { renderShell(); if (route().view === 'dashboard') renderView(); }, 60000);

  // ---------- Local AI assistant (Gemma via Ollama, optional) ----------
  async function checkLlm() {
    try {
      const r = await fetch('/api/llm/health', { signal: AbortSignal.timeout(3000) });
      state.llm = await r.json();
    } catch { state.llm = { available: false, models: [] }; }
    if (route().view === 'settings') renderSettingsStatus();
  }
  const llmModel = () => state.settings.model || state.llm.defaultModel || 'gemma4';

  async function refineWithLlm(id) {
    const c = byId(id); if (!c) return;
    const sys = `You triage passenger complaints for the Ahmedabad-Gandhinagar Metro. Departments: safety, cleanliness, fare, lifts, staff, general.
Return ONLY JSON: {"department": one of the departments, "urgency": integer 0-100, "summary_en": one short English line, "reply": a polite draft reply (max 70 words) written in the SAME language AND script as the complaint (Gujarati script, Devanagari Hindi, English, or romanized Gujlish/Hinglish), mentioning reference ${c.id} and a realistic resolution time}.
Urgency guide: life-safety (fire, smoke, harassment, injury, trapped, suspicious object) 80-100; broken lifts/escalators and safety hazards 50-75; money lost 35-55; cleanliness and staff behaviour 15-45.`;
    const user = `Complaint (channel: ${c.channel}, detected language: ${T.LANGS[c.lang]}, station: ${c.station || 'unknown'}):\n"""${c.text}"""\nRule-engine assessment: department=${c.dept}, urgency=${c.baseUrgency}.`;
    const btn = $('#aiBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Thinking…'; }
    try {
      const r = await fetch('/api/llm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: llmModel(), messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      const out = JSON.parse(data.content);
      const dept = T.DEPARTMENTS[out.department] ? out.department : c.dept;
      const llmU = Number.isFinite(+out.urgency) ? Math.max(0, Math.min(100, Math.round(+out.urgency))) : c.baseUrgency;
      // Never let the model lower a life-safety score.
      const blended = Math.max(c.baseUrgency >= 75 ? c.baseUrgency : 0, Math.round((c.baseUrgency + llmU) / 2));
      update(id, {
        dept, baseUrgency: blended, urgency: blended, level: T.levelFor(blended), dueAt: c.receivedAt + SLA_MS[T.levelFor(blended)],
        aiRefined: true, aiSummary: out.summary_en || '',
        reply: typeof out.reply === 'string' && out.reply.trim() ? out.reply.trim() : c.reply,
      }, { type: 'ai', text: `AI assistant (${llmModel()}) reviewed: ${T.DEPARTMENTS[dept].label}, urgency ${blended}` });
      toast('AI assistant updated the assessment and reply');
    } catch (e) {
      toast('AI assistant unavailable. Keeping the current assessment.');
      if (btn) { btn.disabled = false; btn.textContent = '✨ Improve with AI'; }
    }
  }

  // ---------- Router ----------
  function route() {
    const [view = 'dashboard', a, b] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    return { view, a, b };
  }
  window.addEventListener('hashchange', () => { closeMenu(); refresh(); $('.view').scrollTop = 0; window.scrollTo(0, 0); });

  function refresh() { renderShell(); renderView(); }

  function renderView() {
    const r = route();
    const views = { dashboard: viewDashboard, inbox: viewInbox, new: viewNew, import: viewImport, settings: viewSettings };
    (views[r.view] || viewDashboard)(r);
  }

  // ---------- Shell ----------
  function renderShell() {
    const r = route();
    const act = state.complaints.filter(active);
    const cnt = (f) => act.filter(f).length;
    const link = (href, ico, label, count, dot, on) =>
      `<a href="${href}" class="${on ? 'active' : ''}"><span class="ico">${ico}</span>${esc(label)}${dot ? '<span class="dot" title="Critical"></span>' : ''}<span class="cnt">${count ?? ''}</span></a>`;
    $('#nav').innerHTML = [
      '<div class="sec">Overview</div>',
      link('#/dashboard', '◧', 'Dashboard', '', false, r.view === 'dashboard'),
      '<div class="sec">Inbox</div>',
      link('#/inbox/all', '☰', 'All active', act.length, false, r.view === 'inbox' && r.a === 'all'),
      link('#/inbox/overdue', '⏰', 'Overdue', cnt((c) => overdue(c)) || '', false, r.view === 'inbox' && r.a === 'overdue'),
      '<div class="sec">Department queues</div>',
      ...T.DEPT_ORDER.map((d) => link(`#/inbox/${d}`, DEPT_ICON[d], T.DEPARTMENTS[d].label, cnt((c) => c.dept === d) || '',
        act.some((c) => c.dept === d && c.level === 'critical'), r.view === 'inbox' && r.a === d)),
      '<div class="sec">Tools</div>',
      link('#/import', '⇪', 'Import complaints', '', false, r.view === 'import'),
      link('#/settings', '⚙', 'Settings', '', false, r.view === 'settings'),
    ].join('');

    const p = state.settings.profile;
    $('#sideFoot').innerHTML = p
      ? `<strong>${esc(p.name)}</strong><span>${esc(p.station)} · Station Control</span><span>Device ${esc(state.device)}</span>`
      : `<span>Device ${esc(state.device)}</span>`;
    $('#avatar').textContent = (p?.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

    const pending = Object.keys(state.outbox).length;
    const chip = $('#connChip');
    let cls = '', label;
    if (state.syncing) { cls = 'syncing'; label = 'Syncing…'; }
    else if (!isOnline()) { cls = 'offline'; label = pending ? `Offline · ${pending} pending` : 'Offline'; }
    else if (pending) { cls = 'pending'; label = `${pending} pending`; }
    else label = 'All synced';
    chip.className = 'conn ' + cls;
    chip.innerHTML = `<span class="lbl">${esc(label)}</span>`;
    chip.title = label + (state.settings.lastSync ? ` · last sync ${ago(state.settings.lastSync)}` : '');
  }

  // ---------- Dashboard ----------
  function viewDashboard() {
    const now = Date.now();
    const act = state.complaints.filter(active);
    const p = state.settings.profile;
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    if (!state.complaints.length) {
      $('#view').innerHTML = `
        <div class="page-head"><div><h1>${greet}${p ? ', ' + esc(p.name.split(' ')[0]) : ''}</h1><p class="muted">${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</p></div></div>
        <div class="card"><div class="empty">
          <h3>No complaints yet</h3>
          <p>Log a complaint from the help desk, or import a batch from email, social media or scanned forms.</p>
          <div class="row" style="justify-content:center;margin-top:12px">
            <a class="btn btn-primary" href="#/new">+ New complaint</a><a class="btn" href="#/import">Import complaints</a>
          </div>
        </div></div>`;
      return;
    }

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const crit = act.filter((c) => c.level === 'critical').length;
    const od = act.filter((c) => overdue(c, now)).length;
    const resolvedToday = state.complaints.filter((c) => c.resolvedAt >= today.getTime()).length;
    const acked = state.complaints.filter((c) => c.ackAt);
    const avgAck = acked.length ? acked.reduce((s, c) => s + (c.ackAt - c.receivedAt), 0) / acked.length : null;

    const attention = act.slice().sort((a, b) => (overdue(b) - overdue(a)) || b.urgency - a.urgency).filter((c) => c.level === 'critical' || c.level === 'high' || overdue(c)).slice(0, 7);
    const deptCounts = T.DEPT_ORDER.map((d) => [d, act.filter((c) => c.dept === d)]);
    const maxDept = Math.max(1, ...deptCounts.map(([, l]) => l.length));
    const stations = {};
    for (const c of act) if (c.station) { const s = (stations[c.station] ||= { n: 0, crit: 0, score: 0 }); s.n++; s.score += c.urgency; if (c.level === 'critical') s.crit++; }
    const hot = Object.entries(stations).sort((a, b) => b[1].score - a[1].score).slice(0, 6);
    const langs = Object.entries(state.complaints.reduce((m, c) => ((m[c.lang] = (m[c.lang] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
    const chans = Object.entries(state.complaints.reduce((m, c) => ((m[c.channel] = (m[c.channel] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
    const total = state.complaints.length;
    const bars = (rows, labelFn, max) => `<div class="bars">${rows.map(([k, n]) =>
      `<div class="bar-row"><span>${labelFn(k)}</span><div class="bar"><span style="width:${(n / max) * 100}%"></span></div><span class="n">${n}</span></div>`).join('')}</div>`;

    $('#view').innerHTML = `
      <div class="page-head">
        <div><h1>${greet}${p ? ', ' + esc(p.name.split(' ')[0]) : ''}</h1>
        <p class="muted">${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}${p ? ' · ' + esc(p.station) : ''}</p></div>
        <div class="row"><a class="btn" href="#/import">Import</a><a class="btn btn-primary" href="#/new">+ New complaint</a></div>
      </div>
      <div class="tiles">
        <a class="card tile" href="#/inbox/all"><div class="k">Active complaints</div><div class="v">${act.length}</div><div class="s">${act.filter((c) => c.status === 'open').length} not yet acknowledged</div></a>
        <a class="card tile ${crit ? 'alert' : ''}" href="#/inbox/all"><div class="k">Critical</div><div class="v">${crit}</div><div class="s">Respond within ${slaLabel('critical')}</div></a>
        <a class="card tile ${od ? 'alert' : ''}" href="#/inbox/overdue"><div class="k">Past SLA</div><div class="v">${od}</div><div class="s">Overdue for response</div></a>
        <div class="card tile"><div class="k">Resolved today</div><div class="v">${resolvedToday}</div><div class="s">${avgAck != null ? 'Avg. acknowledgement ' + dur(avgAck) : 'No acknowledgements yet'}</div></div>
      </div>
      <div class="dash">
        <div class="stack">
          <div class="card">
            <div class="card-h"><h2>Needs attention</h2><a class="small" href="#/inbox/all">View inbox →</a></div>
            ${attention.length ? `<ul class="list">${attention.map((c) => `<li><a class="attn" href="#/inbox/all/${c.id}">
              <span class="badge ${c.level}">${c.urgency}</span>
              <div class="t"><div><strong>${esc(T.DEPARTMENTS[c.dept].label)}</strong> · ${esc(c.station || 'Station not stated')}</div><div class="muted small">${esc(c.text)}</div></div>
              <span class="chip ${overdue(c) ? 'overdue' : ''}">${dueLabel(c)}</span></a></li>`).join('')}</ul>`
              : '<div class="empty small">Nothing urgent right now.</div>'}
          </div>
          <div class="card">
            <div class="card-h"><h2>Station hotspots</h2><span class="muted small">Active complaints by station</span></div>
            ${hot.length ? `<table class="tbl"><thead><tr><th>Station</th><th>Active</th><th>Critical</th><th>Top issue</th></tr></thead><tbody>
              ${hot.map(([s, v]) => {
                const top = Object.entries(act.filter((c) => c.station === s).reduce((m, c) => ((m[c.dept] = (m[c.dept] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0][0];
                return `<tr><td><a href="#/inbox/all" data-q="${esc(s)}">${esc(s)}</a></td><td>${v.n}</td><td>${v.crit ? `<span class="badge critical">${v.crit}</span>` : '—'}</td><td>${esc(T.DEPARTMENTS[top].label)}</td></tr>`;
              }).join('')}</tbody></table>` : '<div class="empty small">No station-specific complaints.</div>'}
          </div>
        </div>
        <div class="stack">
          <div class="card"><div class="card-h"><h2>Department queues</h2></div><div class="card-b">
            ${bars(deptCounts.map(([d, l]) => [d, l.length]), (d) => `<a href="#/inbox/${d}">${esc(T.DEPARTMENTS[d].label)}</a>`, maxDept)}
          </div></div>
          <div class="card"><div class="card-h"><h2>Languages</h2><span class="muted small">All complaints</span></div><div class="card-b">
            ${bars(langs, (l) => esc(T.LANGS[l]), total)}
          </div></div>
          <div class="card"><div class="card-h"><h2>Channels</h2><span class="muted small">All complaints</span></div><div class="card-b">
            ${bars(chans, (ch) => esc(CHANNELS[ch] || ch), total)}
          </div></div>
        </div>
      </div>`;
    $$('[data-q]').forEach((a) => (a.onclick = () => { ui.q = a.dataset.q; ui.status = 'active'; $('#globalSearch').value = ui.q; }));
  }

  // ---------- Inbox ----------
  function inboxItems(queue) {
    const q = ui.q.trim().toLowerCase();
    let list = state.complaints.filter((c) => {
      if (queue === 'overdue') { if (!overdue(c)) return false; }
      else if (queue && queue !== 'all' && c.dept !== queue) return false;
      if (queue !== 'overdue') {
        if (ui.status === 'active' && !active(c)) return false;
        if (ui.status !== 'active' && ui.status !== 'all' && c.status !== ui.status) return false;
      }
      if (ui.lang && c.lang !== ui.lang) return false;
      if (q && ![c.text, c.station, c.id, T.DEPARTMENTS[c.dept].label, c.passenger?.name].join(' ').toLowerCase().includes(q)) return false;
      return true;
    });
    const sorters = {
      urgency: (a, b) => b.urgency - a.urgency || a.receivedAt - b.receivedAt,
      newest: (a, b) => b.receivedAt - a.receivedAt,
      due: (a, b) => a.dueAt - b.dueAt,
    };
    return list.sort(sorters[ui.sort]);
  }

  function viewInbox({ a: queue = 'all', b: selId }) {
    const items = inboxItems(queue);
    const title = queue === 'all' ? 'Inbox' : queue === 'overdue' ? 'Overdue' : T.DEPARTMENTS[queue]?.label || 'Inbox';
    const sel = selId && byId(selId);
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>${esc(title)}</h1><p class="muted">${items.length} complaint${items.length === 1 ? '' : 's'}${ui.q ? ` matching “${esc(ui.q)}” <a href="#" id="clearQ">clear</a>` : ''}</p></div>
        <a class="btn btn-primary" href="#/new">+ New complaint</a></div>
      <div class="inbox ${sel ? 'has-sel' : ''}">
        <div class="inbox-list">
          <div class="inbox-tools">
            ${queue === 'overdue' ? '' : `<div class="seg" role="tablist">${[['active', 'Active'], ['open', 'New'], ['in-progress', 'In progress'], ['resolved', 'Resolved'], ['all', 'All']]
              .map(([k, v]) => `<button data-status="${k}" class="${ui.status === k ? 'on' : ''}">${v}</button>`).join('')}</div>`}
            <div class="row">
              <select id="sortSel" aria-label="Sort">${[['urgency', 'Most urgent'], ['due', 'Due soonest'], ['newest', 'Newest']].map(([k, v]) => `<option value="${k}" ${ui.sort === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
              <select id="langSel" aria-label="Language"><option value="">All languages</option>${Object.entries(T.LANGS).map(([k, v]) => `<option value="${k}" ${ui.lang === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
            </div>
          </div>
          <div class="items">
            ${items.map((c) => `<a class="item ${c.id === selId ? 'sel' : ''} ${c.status}" href="#/inbox/${queue}/${c.id}">
              <div class="l1"><span class="lvl ${c.level}"></span><strong style="color:var(--text)">${esc(c.station || 'Station not stated')}</strong><span class="time">${ago(c.receivedAt)}</span></div>
              <div class="txt">${esc(c.text)}</div>
              <div class="l3"><span class="badge ${c.level}">${LEVEL[c.level]} ${c.urgency}</span>
                ${queue === 'all' || queue === 'overdue' ? `<span class="chip">${esc(T.DEPARTMENTS[c.dept].label)}</span>` : ''}
                <span class="chip">${esc(T.LANGS[c.lang])}</span>
                ${active(c) ? `<span class="chip ${overdue(c) ? 'overdue' : ''}">${dueLabel(c)}</span>` : `<span class="status resolved">Resolved</span>`}
                ${c.escalated && active(c) ? '<span class="chip overdue">Escalated</span>' : ''}
                ${c.confidence < 0.5 && !c.overridden ? '<span class="chip" title="Routing confidence is low; please check the department">Check routing</span>' : ''}
              </div></a>`).join('') || `<div class="empty"><h3>All clear</h3><p>No complaints in this view.</p></div>`}
          </div>
        </div>
        <div class="pane" id="pane">${sel ? detailHtml(sel, queue) : `<div class="empty" style="margin-top:80px"><h3>Select a complaint</h3><p>Choose a complaint from the list to see details and reply.</p></div>`}</div>
      </div>`;

    $$('[data-status]').forEach((b) => (b.onclick = () => { ui.status = b.dataset.status; renderView(); }));
    $('#sortSel').onchange = (e) => { ui.sort = e.target.value; renderView(); };
    $('#langSel').onchange = (e) => { ui.lang = e.target.value; renderView(); };
    const cq = $('#clearQ'); if (cq) cq.onclick = (e) => { e.preventDefault(); ui.q = ''; $('#globalSearch').value = ''; renderView(); };
    if (sel) bindDetail(sel, queue);
  }

  function detailHtml(c, queue) {
    const total = Math.min(100, c.signals.reduce((s, x) => s + x.pts, 0));
    const synced = !state.outbox[c.id];
    const actions = c.status === 'open'
      ? `<button class="btn" data-act="ack">Acknowledge</button><button class="btn btn-primary" data-act="resolve">Resolve</button>`
      : c.status === 'in-progress'
        ? `<button class="btn btn-primary" data-act="resolve">Resolve</button>`
        : `<button class="btn" data-act="reopen">Reopen</button>`;
    return `
      <div class="pane-h">
        <div>
          <a class="btn btn-sm back" href="#/inbox/${queue}">← Back</a>
          <h2>${esc(T.DEPARTMENTS[c.dept].label)} <span class="badge ${c.level}">${LEVEL[c.level]} · ${c.urgency}</span> ${c.aiRefined ? '<span class="chip ai">AI reviewed</span>' : ''} ${c.escalated ? '<span class="chip overdue">Escalated by control centre</span>' : ''}</h2>
          <div class="muted small" style="margin-top:4px">${esc(c.id)} · <span class="status ${c.status}">${STATUS[c.status]}</span>${active(c) ? ` · <span style="color:${overdue(c) ? 'var(--critical)' : 'inherit'}">${dueLabel(c)}</span>` : ''}</div>
        </div>
        <div class="row">${actions}</div>
      </div>
      <div class="pane-b">
        <div class="col-main">
          <div class="message">
            <div class="mh"><span>${CH_ICON[c.channel] || ''} ${esc(CHANNELS[c.channel] || c.channel)}</span>·<span>${esc(T.LANGS[c.lang])}</span>·<span>${fmt(c.receivedAt)}</span>
              ${c.passenger?.name ? `·<span>${esc(c.passenger.name)}${c.passenger.contact ? ' (' + esc(c.passenger.contact) + ')' : ''}</span>` : ''}</div>
            <div class="mb" lang="${esc(c.lang.slice(0, 2))}">${esc(c.text)}</div>
          </div>
          ${c.aiSummary ? `<div class="small muted">Summary: ${esc(c.aiSummary)}</div>` : ''}
          <div>
            <div class="section-t">Reply to passenger</div>
            <div class="composer">
              <div class="ch">Language
                <select id="replyLang">${Object.entries(T.LANGS).map(([k, v]) => `<option value="${k}" ${k === c.replyLang ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
                <span class="spacer"></span>${c.replySentAt ? `<span>Sent ${ago(c.replySentAt)}</span>` : '<span>Draft</span>'}
              </div>
              <textarea id="replyText" lang="${esc(c.replyLang.slice(0, 2))}">${esc(c.reply)}</textarea>
              <div class="cf">
                <button class="btn btn-primary btn-sm" data-act="send">${c.replySentAt ? 'Mark sent again' : 'Mark as sent'}</button>
                <button class="btn btn-sm" data-act="copy">Copy</button>
                <button class="btn btn-sm" data-act="regen">Reset draft</button>
                <span class="spacer"></span>
                <button class="btn btn-sm" id="aiBtn" data-act="ai" ${state.llm.available ? '' : 'disabled title="No AI model running on this device"'}>✨ Improve with AI</button>
              </div>
            </div>
          </div>
          <div>
            <div class="section-t">Activity</div>
            <div class="row" style="margin-bottom:14px"><input id="noteText" placeholder="Add an internal note…" style="flex:1"><button class="btn" data-act="note">Add note</button></div>
            <ul class="timeline">${c.history.slice().reverse().map((h) => `<li class="${h.type === 'note' ? 'note' : ''}">
              <div>${h.type === 'note' ? `<strong>${esc(h.by || 'Note')}</strong>` : esc(h.text)}</div>
              ${h.type === 'note' ? `<div class="note-body">${esc(h.text)}</div>` : ''}
              <div class="when">${fmt(h.at)}${h.by && h.type !== 'note' ? ' · ' + esc(h.by) : ''}</div></li>`).join('')}</ul>
          </div>
        </div>
        <div class="col-side">
          <div class="card"><div class="card-b">
            <label>Department
              <select id="deptSel">${T.DEPT_ORDER.map((d) => `<option value="${d}" ${d === c.dept ? 'selected' : ''}>${esc(T.DEPARTMENTS[d].label)}</option>`).join('')}</select>
            </label>
            <div class="small muted" style="margin-top:6px">${c.overridden ? 'Routed manually' : `Auto-routed · ${Math.round(c.confidence * 100)}% confidence`}${c.secondary ? `<br>Also relevant: ${esc(T.DEPARTMENTS[c.secondary].label)}` : ''}</div>
          </div></div>
          <div class="card"><div class="card-b">
            <div class="row" style="justify-content:space-between"><strong>Urgency</strong><span class="badge ${c.level}">${c.urgency} / 100</span></div>
            <div class="meter" style="margin-top:8px"><span style="width:${c.urgency}%;background:${LEVEL_COLOR[c.level]}"></span></div>
            <ul class="why">${c.signals.map((s) => `<li><span>${esc(s.label)}</span><span>+${s.pts}</span></li>`).join('')}
              ${c.aiRefined ? `<li><span>Adjusted by AI review</span><span>${c.urgency - total >= 0 ? '+' : ''}${c.urgency - total}</span></li>` : ''}</ul>
            <div class="small muted" style="margin-top:8px">Response target: ${slaLabel(c.level)}</div>
          </div></div>
          <div class="card"><div class="card-b">
            <dl class="facts">
              <dt>Station</dt><dd>${esc(c.station || 'Not stated')}</dd>
              <dt>Channel</dt><dd>${esc(CHANNELS[c.channel] || c.channel)}</dd>
              <dt>Received</dt><dd>${fmt(c.receivedAt)}</dd>
              ${c.ackAt ? `<dt>Acknowledged</dt><dd>${fmt(c.ackAt)}</dd>` : ''}
              ${c.resolvedAt && c.status === 'resolved' ? `<dt>Resolved</dt><dd>${fmt(c.resolvedAt)}</dd>` : ''}
              <dt>Control centre</dt><dd>${synced ? '✓ Synced' : '⏳ Waiting to sync'}</dd>
            </dl>
          </div></div>
        </div>
      </div>`;
  }

  function bindDetail(c, queue) {
    const pane = $('#pane');
    const name = state.settings.profile?.name;
    let saveTimer;
    $('#replyText').oninput = (e) => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        c.reply = e.target.value; c.replyEdited = true; c.updatedAt = Date.now();
        state.outbox[c.id] = c.updatedAt; persist(); renderShell();
      }, 400);
    };
    $('#replyLang').onchange = (e) => {
      c.replyLang = e.target.value; c.replyEdited = false;
      c.reply = T.draftReply(c, c.replyLang); $('#replyText').value = c.reply;
      c.updatedAt = Date.now(); state.outbox[c.id] = c.updatedAt; persist(); renderShell();
    };
    $('#deptSel').onchange = (e) => {
      const dept = e.target.value;
      state.learned = T.learnCorrection(state.learned, c.text, dept); save(KEY.learned, state.learned);
      const base = T.classify(c.text, { channel: c.channel });
      const delta = T.DEPARTMENTS[dept].base - T.DEPARTMENTS[base.dept].base;
      const score = Math.max(0, Math.min(100, base.urgency + delta));
      const signals = base.signals.map((s, i) => (i === 0 ? { label: `Base for ${T.DEPARTMENTS[dept].label}`, pts: T.DEPARTMENTS[dept].base } : s));
      const level = T.levelFor(score);
      const from = T.DEPARTMENTS[c.dept].label;
      update(c.id, {
        dept, overridden: true, confidence: 1, signals, baseUrgency: score, urgency: score, level, dueAt: c.receivedAt + SLA_MS[level],
        reply: c.replyEdited ? c.reply : T.draftReply({ ...c, dept, level }, c.replyLang),
      }, { type: 'rerouted', text: `Moved from ${from} to ${T.DEPARTMENTS[dept].label}` });
      toast(`Moved to ${T.DEPARTMENTS[dept].label}. Similar complaints will be routed there.`);
      if (queue !== 'all' && queue !== 'overdue') location.hash = `#/inbox/${dept}/${c.id}`;
    };
    pane.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
      if (act === 'ack') update(c.id, { status: 'in-progress', ackAt: c.ackAt || Date.now() }, { type: 'status', text: 'Acknowledged; work in progress' });
      if (act === 'resolve') update(c.id, { status: 'resolved', resolvedAt: Date.now(), ackAt: c.ackAt || Date.now() }, { type: 'status', text: 'Marked resolved' });
      if (act === 'reopen') update(c.id, { status: 'open', resolvedAt: null }, { type: 'status', text: 'Reopened' });
      if (act === 'copy') { try { await navigator.clipboard.writeText($('#replyText').value); toast('Reply copied'); } catch { $('#replyText').select(); } }
      if (act === 'regen') { c.replyEdited = false; $('#replyText').value = c.reply = T.draftReply(c, c.replyLang); persist(); }
      if (act === 'send') {
        const patch = { reply: $('#replyText').value, replySentAt: Date.now() };
        if (c.status === 'open') Object.assign(patch, { status: 'in-progress', ackAt: c.ackAt || Date.now() });
        update(c.id, patch, { type: 'reply', text: `Reply sent to passenger in ${T.LANGS[c.replyLang]}` });
        toast('Reply recorded as sent');
      }
      if (act === 'note') {
        const text = $('#noteText').value.trim(); if (!text) return;
        update(c.id, {}, { type: 'note', text, by: name || 'Controller' });
      }
      if (act === 'ai') refineWithLlm(c.id);
    };
    $('#noteText').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); pane.querySelector('[data-act=note]').click(); } };
  }

  // ---------- New complaint ----------
  function stationOptions(selected = '', autoLabel = 'Detect from text') {
    return `<option value="">${autoLabel}</option>` + T.STATIONS.map(([s]) => `<option ${s === selected ? 'selected' : ''}>${esc(s)}</option>`).join('');
  }

  function viewNew() {
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>New complaint</h1><p class="muted">Log a complaint received at the help desk, by phone or on a paper form.</p></div></div>
      <div class="two">
        <form class="card card-b" id="newForm">
          <div class="form-grid">
            <label>Channel<select name="channel">${Object.entries(CHANNELS).map(([k, v]) => `<option value="${k}" ${k === 'paper' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
            <label>Station<select name="station">${stationOptions()}</select></label>
            <label><span>Passenger name <span class="muted small">(optional)</span></span><input name="name" autocomplete="off"></label>
            <label><span>Phone or email <span class="muted small">(optional)</span></span><input name="contact" autocomplete="off"></label>
            <label class="full"><span>Complaint <span class="muted small">in any language: English, ગુજરાતી, हिन्दी, or mixed</span></span>
              <textarea name="text" rows="7" required placeholder="Type or paste the passenger's complaint…"></textarea></label>
          </div>
          <div class="row" style="margin-top:16px;justify-content:flex-end"><a class="btn" href="#/inbox/all">Cancel</a><button class="btn btn-primary">Create complaint</button></div>
        </form>
        <div class="card preview-card"><div class="card-h"><h2>Automatic assessment</h2><span class="muted small">On this device</span></div><div class="card-b" id="livePreview"><p class="muted">Start typing to see the department, urgency and language.</p></div></div>
      </div>`;
    const form = $('#newForm');
    const preview = () => {
      const text = form.text.value.trim();
      if (!text) { $('#livePreview').innerHTML = '<p class="muted">Start typing to see the department, urgency and language.</p>'; return; }
      const r = T.classify(text, { channel: form.channel.value, learned: state.learned });
      const st = form.station.value || r.station;
      $('#livePreview').innerHTML = `
        <div class="k">Department</div><div class="big">${DEPT_ICON[r.dept]} ${esc(T.DEPARTMENTS[r.dept].label)}</div>
        <div class="row" style="margin:10px 0"><span class="badge ${r.level}">${LEVEL[r.level]} · ${r.urgency}</span><span class="chip">${esc(T.LANGS[r.lang])}</span><span class="chip">${esc(st || 'Station not detected')}</span></div>
        <div class="meter"><span style="width:${r.urgency}%;background:${LEVEL_COLOR[r.level]}"></span></div>
        <ul class="why">${r.signals.map((s) => `<li><span>${esc(s.label)}</span><span>+${s.pts}</span></li>`).join('')}</ul>
        <p class="small muted" style="margin-bottom:0">Response target: ${slaLabel(r.level)}. A reply will be drafted in ${esc(T.LANGS[r.lang])}.</p>`;
    };
    form.oninput = preview;
    form.onsubmit = (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const { created } = addComplaints([f]);
      toast('Complaint created and routed');
      location.hash = `#/inbox/all/${created[0].id}`;
    };
    form.text.focus();
  }

  // ---------- Import ----------
  function parseBatch(raw) {
    return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
      const m = line.match(/^(app|social|twitter|x|email|paper)\s*[:,]\s*(.+)$/i);
      const unq = (s) => s.replace(/^"|"$/g, '').replace(/""/g, '"');
      if (!m) return { channel: 'email', text: unq(line) };
      const ch = m[1].toLowerCase();
      return { channel: ch === 'twitter' || ch === 'x' ? 'social' : ch, text: unq(m[2]) };
    }).filter((r) => !/^text$/i.test(r.text));
  }

  function viewImport() {
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>Import complaints</h1><p class="muted">Bring in complaints from the email inbox, social media exports or transcribed paper forms.</p></div></div>
      <div class="card card-b">
        <label>Complaints, one per line
          <textarea id="imp" rows="8" placeholder="social: Platform pe dhuaan aa raha hai Gurukul Road station pe&#10;email: વસ્ત્રાલ સ્ટેશન પર ટોઇલેટ ખૂબ ગંદા છે&#10;paper, Escalator at Ranip not working since Monday"></textarea>
        </label>
        <p class="small muted">Start a line with <b>app:</b>, <b>social:</b>, <b>email:</b> or <b>paper:</b> to set the channel. CSV files with <b>channel,text</b> columns also work.</p>
        <div class="row"><button class="btn" id="impPreview">Preview</button><label class="btn">Choose file…<input type="file" id="impFile" accept=".txt,.csv" hidden></label></div>
      </div>
      <div id="impResult" style="margin-top:16px"></div>`;
    let rows = [];
    const show = () => {
      rows = parseBatch($('#imp').value);
      if (!rows.length) { $('#impResult').innerHTML = ''; return; }
      const res = rows.map((r) => ({ ...r, ...T.classify(r.text, { channel: r.channel, learned: state.learned }) }));
      $('#impResult').innerHTML = `<div class="card">
        <div class="card-h"><h2>${rows.length} complaint${rows.length > 1 ? 's' : ''} ready</h2><button class="btn btn-primary" id="impGo">Import ${rows.length}</button></div>
        <div class="card-b flush" style="overflow-x:auto"><table class="tbl"><thead><tr><th>Urgency</th><th>Department</th><th>Language</th><th>Station</th><th>Complaint</th></tr></thead><tbody>
        ${res.map((r) => `<tr><td><span class="badge ${r.level}">${r.urgency}</span></td><td>${esc(T.DEPARTMENTS[r.dept].label)}</td><td>${esc(T.LANGS[r.lang])}</td><td>${esc(r.station || '—')}</td><td>${esc(r.text)}</td></tr>`).join('')}
        </tbody></table></div></div>`;
      $('#impGo').onclick = () => {
        const { created, ms } = addComplaints(rows);
        toast(`Imported ${created.length} complaints (sorted in ${ms.toFixed(0)} ms)`);
        location.hash = '#/inbox/all';
      };
    };
    $('#impPreview').onclick = show;
    $('#impFile').onchange = async (e) => { const f = e.target.files[0]; if (f) { $('#imp').value = await f.text(); show(); } e.target.value = ''; };
  }

  // ---------- Settings ----------
  function viewSettings() {
    const p = state.settings.profile || { name: '', station: '' };
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>Settings</h1><p class="muted">This device and its connection to the control centre.</p></div></div>
      <div class="settings">
        <div class="card"><div class="card-h"><h2>Profile</h2></div>
          <form class="card-b form-grid" id="profForm">
            <label>Name<input name="name" value="${esc(p.name)}" required></label>
            <label>Station<select name="station">${stationOptions(p.station, 'Select station')}</select></label>
            <div class="full row" style="justify-content:flex-end"><button class="btn btn-primary">Save profile</button></div>
          </form></div>

        <div class="card"><div class="card-h"><h2>Connection &amp; sync</h2></div>
          <div class="set-row"><div><div>Work offline</div><div class="d">Keep everything on this device and stop sending updates until you switch back.</div></div>
            <label class="switch"><input type="checkbox" id="offSw" ${state.settings.offline ? 'checked' : ''}></label></div>
          <div class="set-row"><div><div>Control centre</div><div class="d" id="syncStatus"></div></div>
            <button class="btn" id="syncNow">Sync now</button></div>
          <div class="set-row" style="display:block"><div class="small muted" style="margin-bottom:6px">Recent activity</div>
            <ul class="small muted" id="syncLog" style="margin:0;padding-left:18px;max-height:160px;overflow:auto"></ul></div>
        </div>

        <div class="card"><div class="card-h"><h2>AI assistant</h2></div>
          <div class="set-row"><div><div id="aiStatus">Checking…</div><div class="d">Runs a Gemma model on this computer through Ollama. It needs no internet. Without it, Sunvai still sorts and drafts replies on its own.</div></div>
            <button class="btn" id="aiCheck">Check again</button></div>
          <div class="set-row"><div><div>Model</div><div class="d">Name of the installed model, as shown by <code>ollama list</code>.</div></div>
            <input id="aiModel" value="${esc(state.settings.model || '')}" placeholder="${esc(state.llm.defaultModel || 'gemma4')}" style="width:200px"></div>
        </div>

        <div class="card"><div class="card-h"><h2>Data</h2></div>
          <div class="set-row"><div><div>Export complaints</div><div class="d">Download all complaints on this device.</div></div>
            <div class="row"><button class="btn" id="expCsv">CSV</button><button class="btn" id="expJson">JSON</button></div></div>
          <div class="set-row"><div><div>Demo data</div><div class="d">Add 25 example complaints in English, Gujarati, Hindi and mixed languages for training.</div></div>
            <button class="btn" id="demo">Load demo data</button></div>
          <div class="set-row"><div><div>Clear this device</div><div class="d">Remove all complaints stored on this device.</div></div>
            <button class="btn btn-danger" id="wipe">Clear data</button></div>
        </div>
        <p class="small muted">Sunvai Grievance Desk v1.1 · Device ${esc(state.device)} · <a href="/admin" target="_blank" rel="noopener">Control centre console</a></p>
      </div>`;

    $('#profForm').onsubmit = (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      state.settings.profile = { name: f.name.trim(), station: f.station || p.station };
      saveSettings(); renderShell(); toast('Profile saved');
    };
    $('#offSw').onchange = (e) => {
      state.settings.offline = e.target.checked; saveSettings();
      addLog(e.target.checked ? 'Switched to offline mode' : 'Back online');
      renderShell(); renderSettingsStatus();
      if (!e.target.checked) trySync();
    };
    $('#syncNow').onclick = () => trySync(true);
    $('#aiCheck').onclick = () => { $('#aiStatus').textContent = 'Checking…'; checkLlm(); };
    $('#aiModel').onchange = (e) => { state.settings.model = e.target.value.trim(); saveSettings(); toast('Model saved'); };
    $('#expCsv').onclick = exportCsv;
    $('#expJson').onclick = () => download(`sunvai-complaints-${dateStamp()}.json`, JSON.stringify(state.complaints, null, 2), 'application/json');
    $('#demo').onclick = loadDemo;
    $('#wipe').onclick = () => {
      const n = Object.keys(state.outbox).length;
      if (!confirm(n ? `${n} update(s) haven't reached the control centre yet and will be lost. Clear anyway?` : 'Remove all complaints from this device?')) return;
      state.complaints = []; state.outbox = {}; persist(); refresh(); toast('Device cleared');
    };
    renderSettingsStatus();
    checkLlm();
    fetch('/api/health', { signal: AbortSignal.timeout(3000) }).then((r) => { state.server = r.ok; }).catch(() => { state.server = false; }).finally(renderSettingsStatus);
  }

  function renderSettingsStatus() {
    const s = $('#syncStatus'); if (!s) return;
    const pending = Object.keys(state.outbox).length;
    const reach = !isOnline() ? 'Offline' : state.server === false ? 'Not reachable' : state.server ? 'Connected' : 'Checking…';
    s.textContent = `${reach} · ${pending ? pending + ' update(s) waiting' : 'nothing waiting'} · last sync ${state.settings.lastSync ? ago(state.settings.lastSync) : 'never'}`;
    $('#syncLog').innerHTML = state.log.slice(0, 15).map((l) => `<li>${fmt(l.at)}: ${esc(l.msg)}</li>`).join('') || '<li>No activity yet</li>';
    const ai = $('#aiStatus');
    if (ai) ai.innerHTML = state.llm.available
      ? `<span class="status resolved">Ready</span> <span class="small muted">${state.llm.models.length} model(s) installed</span>`
      : '<span class="status">Not available</span> <span class="small muted">Sorting and replies still work on their own</span>';
  }

  function loadDemo() {
    const now = Date.now();
    const items = window.SAMPLE_COMPLAINTS.map(([channel, text], i) => {
      const lvl = T.classify(text, { channel }).level;
      const mins = lvl === 'critical' ? 2 + i % 9 : lvl === 'high' ? 20 + i * 7 : 30 + i * 23;
      return { channel, text, receivedAt: now - mins * 60e3 };
    });
    const { created } = addComplaints(items);
    toast(`Added ${created.length} demo complaints`);
    location.hash = '#/dashboard';
  }

  const dateStamp = () => new Date().toISOString().slice(0, 10);
  function download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportCsv() {
    const cols = ['id', 'received', 'channel', 'language', 'department', 'urgency', 'level', 'station', 'status', 'complaint', 'reply'];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = state.complaints.map((c) => [c.id, new Date(c.receivedAt).toISOString(), c.channel, T.LANGS[c.lang], T.DEPARTMENTS[c.dept].label,
      c.urgency, c.level, c.station || '', c.status, c.text, c.reply].map(q).join(','));
    download(`sunvai-complaints-${dateStamp()}.csv`, '﻿' + [cols.join(','), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
  }

  // ---------- Global wiring ----------
  $('#searchForm').onsubmit = (e) => {
    e.preventDefault();
    ui.q = $('#globalSearch').value; ui.status = 'all';
    if (route().view !== 'inbox') location.hash = '#/inbox/all'; else renderView();
  };
  $('#globalSearch').oninput = (e) => { if (route().view === 'inbox') { ui.q = e.target.value; renderView(); $('#globalSearch').focus(); } };
  $('#connChip').onclick = () => trySync(true);

  const closeMenu = () => { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); };
  $('#menuBtn').onclick = () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); };
  $('#scrim').onclick = closeMenu;

  let toastTimer;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function onboard() {
    if (state.settings.profile) return;
    const dlg = $('#onboard');
    $('#onboardStation').innerHTML = T.STATIONS.map(([s]) => `<option>${esc(s)}</option>`).join('');
    dlg.addEventListener('cancel', (e) => e.preventDefault());
    $('#onboardForm').onsubmit = () => {
      const f = Object.fromEntries(new FormData($('#onboardForm')));
      state.settings.profile = { name: f.name.trim(), station: f.station };
      saveSettings(); refresh();
    };
    dlg.showModal();
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (!location.hash) location.replace('#/dashboard');
  applyCorroboration();
  refresh();
  onboard();
  checkLlm();
  trySync();
})();
