/* Every Complaint Heard — offline-first controller app. */
(() => {
  'use strict';
  const T = window.Triage;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Persistence (localStorage, wrapped so a blocked store never breaks triage) ----------
  const KEY = { complaints: 'ech.complaints', outbox: 'ech.outbox', settings: 'ech.settings', learned: 'ech.learned', log: 'ech.synclog', device: 'ech.device' };
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Storage full or blocked: ' + e.message); } };

  const state = {
    complaints: load(KEY.complaints, []),
    outbox: load(KEY.outbox, {}),          // id -> updatedAt waiting for HQ ack
    settings: load(KEY.settings, { forceOffline: false, model: '' }),
    learned: load(KEY.learned, {}),
    log: load(KEY.log, []),
    device: load(KEY.device, null),
    llm: { available: false, models: [] },
    syncing: false,
  };
  if (!state.device) { state.device = 'STN-' + Math.random().toString(36).slice(2, 7).toUpperCase(); save(KEY.device, state.device); }

  const persist = () => { save(KEY.complaints, state.complaints); save(KEY.outbox, state.outbox); };
  const byId = (id) => state.complaints.find((c) => c.id === id);

  const CHANNELS = { app: '📱 App', social: '💬 Social', email: '✉️ Email', paper: '📝 Paper' };
  const LEVEL_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
  const LEVEL_COLOR = { critical: 'var(--critical)', high: 'var(--high)', medium: 'var(--medium)', low: 'var(--low)' };

  // ---------- Triage ----------
  function newId() {
    const d = new Date();
    const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `GM${ymd}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  }

  function triage(text, channel = 'app') {
    const r = T.classify(text, { channel, learned: state.learned });
    const c = {
      id: newId(), text: text.trim(), channel, receivedAt: Date.now(),
      ...r, baseUrgency: r.urgency, status: 'open', overridden: false, aiRefined: false,
      replyLang: r.lang, updatedAt: Date.now(), device: state.device,
    };
    c.reply = T.draftReply(c);
    return c;
  }

  // Several open reports about the same station + department corroborate each other.
  function applyCorroboration() {
    const groups = {};
    for (const c of state.complaints) if (c.status !== 'resolved' && c.station) (groups[c.station + '|' + c.dept] ||= []).push(c);
    for (const c of state.complaints) {
      const n = c.status !== 'resolved' && c.station ? groups[c.station + '|' + c.dept].length : 1;
      const bonus = Math.min(15, 5 * (n - 1));
      c.signals = c.signals.filter((s) => s.id !== 'corroboration');
      if (bonus) c.signals.push({ id: 'corroboration', label: `${n} open reports for this station & issue`, pts: bonus });
      const next = Math.min(100, c.baseUrgency + bonus);
      if (next !== c.urgency) {
        c.urgency = next; c.level = T.levelFor(next);
        if (!c.replyEdited && !c.aiRefined) c.reply = T.draftReply(c, c.replyLang);
      }
    }
  }

  function addComplaints(items) {
    const t0 = performance.now();
    const created = items.filter(([, text]) => text && text.trim()).map(([channel, text]) => triage(text, channel));
    const ms = performance.now() - t0;
    state.complaints.push(...created);
    for (const c of created) markDirty(c, false);
    applyCorroboration();
    persist(); render(); trySync();
    return { count: created.length, ms };
  }

  function markDirty(c, bump = true) {
    if (bump) c.updatedAt = Date.now();
    state.outbox[c.id] = c.updatedAt;
  }

  function update(id, patch) {
    const c = byId(id); if (!c) return;
    Object.assign(c, patch);
    markDirty(c);
    applyCorroboration();
    persist(); render(); trySync();
  }

  // ---------- Network & sync ----------
  const isOnline = () => navigator.onLine && !state.settings.forceOffline;

  async function trySync(manual = false) {
    if (state.syncing) return;
    const ids = Object.keys(state.outbox);
    if (!ids.length) { if (manual) toast('Nothing to sync — HQ is up to date'); renderNet(); return; }
    if (!isOnline()) { if (manual) toast(`Offline — ${ids.length} record(s) kept in the outbox`); renderNet(); return; }
    state.syncing = true; renderNet();
    const records = ids.map(byId).filter(Boolean).map(({ signals, deptScores, matched, ...rest }) => ({ ...rest, signals }));
    try {
      const res = await fetch('/api/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: state.device, records }), signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const { accepted } = await res.json();
      for (const a of accepted) if (state.outbox[a.id] !== undefined && state.outbox[a.id] <= a.updatedAt) delete state.outbox[a.id];
      // Records that were removed locally but still queued are dropped too.
      for (const id of Object.keys(state.outbox)) if (!byId(id)) delete state.outbox[id];
      save(KEY.outbox, state.outbox);
      addLog(`Synced ${accepted.length} record(s) to HQ`);
      state.settings.lastSync = Date.now(); save(KEY.settings, state.settings);
      if (manual) toast(`Synced ${accepted.length} record(s) to HQ`);
      if ($('#tab-sync').classList.contains('active')) refreshHq();
    } catch (e) {
      addLog(`Sync failed (${e.message}) — will retry`);
      if (manual) toast('HQ unreachable — records stay queued and will retry');
    } finally {
      state.syncing = false; renderNet(); renderSync();
    }
  }

  function addLog(msg) {
    state.log.unshift({ at: Date.now(), msg });
    state.log = state.log.slice(0, 40);
    save(KEY.log, state.log);
  }

  window.addEventListener('online', () => { renderNet(); trySync(); checkLlm(); });
  window.addEventListener('offline', renderNet);
  setInterval(() => trySync(), 15000);

  // ---------- Local LLM (Gemma via Ollama, optional) ----------
  async function checkLlm() {
    try {
      const r = await fetch('/api/llm/health', { signal: AbortSignal.timeout(3000) });
      state.llm = await r.json();
    } catch { state.llm = { available: false, models: [] }; }
    renderLlm();
  }

  function llmModel() { return state.settings.model || state.llm.defaultModel || 'gemma4'; }

  async function refineWithLlm(id) {
    const c = byId(id); if (!c) return;
    const sys = `You triage passenger complaints for the Ahmedabad-Gandhinagar Metro. Departments: safety, cleanliness, fare, lifts, staff, general.
Return ONLY JSON: {"department": one of the departments, "urgency": integer 0-100, "summary_en": one short English line, "reply": a polite draft reply (max 70 words) written in the SAME language AND script as the complaint (Gujarati script, Devanagari Hindi, English, or romanized Gujlish/Hinglish), mentioning reference ${c.id} and a realistic resolution time}.
Urgency guide: life-safety (fire, smoke, harassment, injury, trapped, suspicious object) 80-100; broken lifts/escalators and safety hazards 50-75; money lost 35-55; cleanliness and staff behaviour 15-45.`;
    const user = `Complaint (channel: ${c.channel}, detected language: ${T.LANGS[c.lang]}, station: ${c.station || 'unknown'}):\n"""${c.text}"""\nRule-engine guess: department=${c.dept}, urgency=${c.baseUrgency}.`;
    toast(`Asking ${llmModel()} on this device…`);
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
      // Blend: never let the model lower a life-safety score below the rule engine's.
      const blended = Math.max(c.baseUrgency >= 75 ? c.baseUrgency : 0, Math.round((c.baseUrgency + llmU) / 2));
      update(id, {
        dept, baseUrgency: blended, urgency: blended, level: T.levelFor(blended), aiRefined: true,
        aiSummary: out.summary_en || '', reply: typeof out.reply === 'string' && out.reply.trim() ? out.reply.trim() : c.reply,
        aiNote: `${llmModel()}: ${out.department} / ${llmU} (rules: ${c.dept} / ${c.baseUrgency})`,
      });
      openDetail(id);
      toast('Refined by local model');
    } catch (e) {
      toast('Local model unavailable — keeping rule-engine result. ' + (e.message || ''));
    }
  }

  // ---------- Rendering ----------
  function render() { renderStats(); renderCritical(); renderBoard(); renderNet(); renderSync(); }

  function filtered() {
    const q = $('#search').value.trim().toLowerCase();
    const lv = $('#fLevel').value, lg = $('#fLang').value, st = $('#fStatus').value;
    return state.complaints.filter((c) =>
      (!lv || c.level === lv) && (!lg || c.lang === lg) && (!st || c.status === st) &&
      (!q || [c.text, c.station, c.id, c.dept].join(' ').toLowerCase().includes(q)));
  }

  function renderStats() {
    const open = state.complaints.filter((c) => c.status !== 'resolved');
    const crit = open.filter((c) => c.level === 'critical').length;
    const high = open.filter((c) => c.level === 'high').length;
    const langs = new Set(state.complaints.map((c) => c.lang)).size;
    const minutesSaved = state.complaints.length * 3; // assumption: ~3 min manual read-sort-route per complaint
    $('#stats').innerHTML = [
      ['Open complaints', open.length, ''],
      ['Critical now', crit, 'crit'],
      ['High priority', high, ''],
      ['Languages seen', langs, ''],
      ['Manual sorting saved', minutesSaved >= 60 ? `${(minutesSaved / 60).toFixed(1)} h` : `${minutesSaved} min`, ''],
    ].map(([k, v, cls]) => `<div class="stat ${cls}"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');

    const hs = {};
    for (const c of open) if (c.station) hs[c.station] = (hs[c.station] || 0) + c.urgency;
    const top = Object.entries(hs).sort((a, b) => b[1] - a[1]).slice(0, 3);
    $('#hotspots').innerHTML = top.length ? '🔥 Hotspots: ' + top.map(([s]) => esc(s)).join(' · ') : '';
  }

  function renderCritical() {
    const crit = state.complaints.filter((c) => c.status === 'open' && c.level === 'critical').sort((a, b) => b.urgency - a.urgency);
    $('#critical').innerHTML = crit.map((c) => `
      <div class="crit-item" data-id="${c.id}">
        <span class="badge critical">${c.urgency}</span>
        <strong>${esc(T.DEPARTMENTS[c.dept].label)}</strong>
        <span class="t">${esc(c.station ? c.station + ' — ' : '')}${esc(c.text)}</span>
        <span class="muted">SLA ${T.SLA.critical}</span>
      </div>`).join('');
  }

  function renderBoard() {
    const list = filtered();
    $('#emptyBoard').hidden = state.complaints.length > 0;
    $('#board').hidden = state.complaints.length === 0;
    $('#board').innerHTML = T.DEPT_ORDER.map((d) => {
      const items = list.filter((c) => c.dept === d).sort((a, b) => b.urgency - a.urgency || a.receivedAt - b.receivedAt);
      return `<div class="col">
        <div class="col-h"><span>${esc(T.DEPARTMENTS[d].label)}</span><span class="n">${items.length}</span></div>
        <div class="col-b">${items.map(ticketHtml).join('') || '<div class="muted" style="padding:6px">—</div>'}</div>
      </div>`;
    }).join('');
  }

  function ticketHtml(c) {
    const lowConf = c.confidence < 0.5 && !c.overridden;
    return `<div class="ticket ${c.level}" data-id="${c.id}" tabindex="0">
      <div class="meta">
        <span class="badge ${c.level}">${LEVEL_LABEL[c.level]} <span class="score">${c.urgency}</span></span>
        <span class="tag">${esc(T.LANGS[c.lang])}</span>
        <span>${CHANNELS[c.channel] || esc(c.channel)}</span>
        ${lowConf ? '<span class="tag warn" title="Low routing confidence — please check">review</span>' : ''}
        ${c.aiRefined ? '<span class="tag ai">AI</span>' : ''}
      </div>
      <div class="txt">${esc(c.text)}</div>
      <div class="foot"><span>${esc(c.station || 'Station unknown')}</span><span>${c.status === 'open' ? '' : esc(c.status)} ${state.outbox[c.id] ? '⏳' : '✓'}</span></div>
    </div>`;
  }

  function renderNet() {
    const online = isOnline();
    const pill = $('#netPill');
    pill.className = 'pill ' + (online ? 'online' : 'offline');
    pill.textContent = state.syncing ? 'Syncing…' : online ? 'Online' : 'Offline';
    const n = Object.keys(state.outbox).length;
    $('#queuePill').textContent = n ? `${n} queued` : 'All synced';
    $('#forceOffline').checked = !!state.settings.forceOffline;
  }

  function renderSync() {
    $('#deviceId').textContent = state.device;
    $('#localCount').textContent = state.complaints.length;
    $('#outboxCount').textContent = Object.keys(state.outbox).length;
    $('#lastSync').textContent = state.settings.lastSync ? new Date(state.settings.lastSync).toLocaleString() : 'never';
    $('#syncLog').innerHTML = state.log.map((l) => `<li>${new Date(l.at).toLocaleTimeString()} — ${esc(l.msg)}</li>`).join('');
  }

  function renderLlm() {
    const el = $('#llmStatus');
    el.className = 'pill ' + (state.llm.available ? 'online' : 'offline');
    el.textContent = state.llm.available ? `Local model ready (${state.llm.models.length} installed)` : 'No local model — rule engine only';
    $('#llmModel').value = state.settings.model || '';
    $('#llmModel').placeholder = state.llm.defaultModel || 'gemma4';
  }

  async function refreshHq() {
    const el = $('#hq');
    if (!isOnline()) { el.innerHTML = '<p class="muted">HQ is not reachable while offline.</p>'; return; }
    try {
      const r = await fetch('/api/hq', { signal: AbortSignal.timeout(5000) });
      const { records } = await r.json();
      records.sort((a, b) => b.urgency - a.urgency);
      el.innerHTML = `<p class="muted">${records.length} record(s) at HQ</p>
        <table><thead><tr><th>ID</th><th>Dept</th><th>Urg.</th><th>Lang</th><th>Station</th><th>Status</th><th>From</th></tr></thead><tbody>
        ${records.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(T.DEPARTMENTS[r.dept]?.label || r.dept)}</td><td><span class="badge ${esc(r.level)}">${r.urgency}</span></td><td>${esc(T.LANGS[r.lang] || r.lang)}</td><td>${esc(r.station || '—')}</td><td>${esc(r.status)}</td><td>${esc(r.device)}</td></tr>`).join('')}
        </tbody></table>`;
    } catch {
      el.innerHTML = '<p class="muted">HQ unreachable.</p>';
    }
  }

  // ---------- Detail dialog ----------
  function openDetail(id) {
    const c = byId(id); if (!c) return;
    const form = $('#detailForm');
    const total = c.signals.reduce((s, x) => s + x.pts, 0);
    form.innerHTML = `
      <div class="head">
        <div>
          <h2>${esc(c.id)} <span class="badge ${c.level}">${LEVEL_LABEL[c.level]} · ${c.urgency}</span></h2>
          <div class="muted">${CHANNELS[c.channel] || esc(c.channel)} · ${esc(T.LANGS[c.lang])} · ${esc(c.station || 'station unknown')} · received ${new Date(c.receivedAt).toLocaleString()} · SLA ${T.SLA[c.level]}</div>
        </div>
        <button class="btn btn-sm" value="close" aria-label="Close">✕</button>
      </div>
      <div class="orig" lang="${esc(c.lang.slice(0, 2))}">${esc(c.text)}</div>
      ${c.aiSummary ? `<div class="ai-note">AI summary: ${esc(c.aiSummary)}</div>` : ''}
      <div class="grid">
        <div>
          <label>Department queue
            <select id="dDept">${T.DEPT_ORDER.map((d) => `<option value="${d}" ${d === c.dept ? 'selected' : ''}>${esc(T.DEPARTMENTS[d].label)}</option>`).join('')}</select>
          </label>
          <div class="muted" style="font-size:12px">Routing confidence ${Math.round(c.confidence * 100)}%${c.secondary ? ` · also relevant: ${esc(T.DEPARTMENTS[c.secondary].label)}` : ''}${c.overridden ? ' · re-routed by controller' : ''}</div>
          <label style="margin-top:10px">Status
            <select id="dStatus">${['open', 'in-progress', 'resolved'].map((s) => `<option ${s === c.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
          </label>
        </div>
        <div>
          <strong>Why this urgency</strong>
          <div class="meter" style="margin:6px 0"><span style="width:${c.urgency}%;background:${LEVEL_COLOR[c.level]}"></span></div>
          <ul class="signals">
            ${c.signals.map((s) => `<li><span>${esc(s.label)}</span><span>+${s.pts}</span></li>`).join('')}
            <li class="total"><span>Score (capped at 100)</span><span>${Math.min(100, total)}${c.aiRefined ? ' → ' + c.urgency + ' (AI blend)' : ''}</span></li>
          </ul>
          ${c.aiNote ? `<div class="ai-note">${esc(c.aiNote)}</div>` : ''}
        </div>
      </div>
      <div>
        <div class="row" style="justify-content:space-between;margin:0 0 6px">
          <strong>Draft reply</strong>
          <label>Language
            <select id="dLang">${Object.entries(T.LANGS).map(([k, v]) => `<option value="${k}" ${k === c.replyLang ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
          </label>
        </div>
        <textarea id="dReply" rows="5">${esc(c.reply)}</textarea>
      </div>
      <div class="row">
        <button class="btn btn-primary" value="save" id="dSave">Save</button>
        <button class="btn" type="button" id="dCopy">Copy reply</button>
        <button class="btn" type="button" id="dRegen">Regenerate reply</button>
        <button class="btn" type="button" id="dLlm" ${state.llm.available ? '' : 'disabled title="Start Ollama with a Gemma model to enable"'}>✨ Refine with local Gemma</button>
      </div>`;

    $('#dLang').onchange = (e) => { $('#dReply').value = T.draftReply({ ...c, dept: $('#dDept').value }, e.target.value); };
    $('#dRegen').onclick = () => { $('#dReply').value = T.draftReply({ ...c, dept: $('#dDept').value }, $('#dLang').value); };
    $('#dCopy').onclick = async () => { try { await navigator.clipboard.writeText($('#dReply').value); toast('Reply copied'); } catch { $('#dReply').select(); } };
    $('#dLlm').onclick = () => { $('#detail').close(); refineWithLlm(c.id); };
    $('#dSave').onclick = () => {
      const dept = $('#dDept').value;
      const patch = { status: $('#dStatus').value, reply: $('#dReply').value, replyLang: $('#dLang').value, replyEdited: $('#dReply').value !== c.reply || c.replyEdited };
      if (dept !== c.dept) {
        state.learned = T.learnCorrection(state.learned, c.text, dept);
        save(KEY.learned, state.learned);
        // Re-score urgency for the new department, keeping any AI blend out of it.
        const r = T.classify(c.text, { channel: c.channel, learned: state.learned });
        const sig = T.classify(c.text, { channel: c.channel });
        Object.assign(patch, { dept, overridden: true, confidence: 1, secondary: r.secondary });
        const rescored = rescoreFor(c.text, c.channel, dept, sig);
        Object.assign(patch, rescored);
        toast(`Re-routed to ${T.DEPARTMENTS[dept].label} — this device will learn from it`);
      }
      update(c.id, patch);
    };
    $('#detail').showModal();
  }

  // Urgency for a forced department: reuse classify() signals but swap the department base score.
  function rescoreFor(text, channel, dept, sig) {
    const oldBase = T.DEPARTMENTS[sig.dept].base;
    const signals = sig.signals.map((s, i) => (i === 0 ? { label: `Base for ${T.DEPARTMENTS[dept].label}`, pts: T.DEPARTMENTS[dept].base } : s));
    const score = Math.min(100, sig.urgency - oldBase + T.DEPARTMENTS[dept].base);
    return { signals, baseUrgency: score, urgency: score, level: T.levelFor(score) };
  }

  // ---------- Intake ----------
  function parseBatch(raw) {
    return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const m = line.match(/^(app|social|twitter|x|email|paper)\s*[:,]\s*(.+)$/i);
      if (!m) return ['app', line.replace(/^"|"$/g, '')];
      const ch = m[1].toLowerCase();
      return [ch === 'twitter' || ch === 'x' ? 'social' : ch, m[2].replace(/^"|"$/g, '')];
    }).filter(([, t]) => !/^text$/i.test(t));
  }

  $('#addOne').onclick = () => {
    const text = $('#oneText').value;
    if (!text.trim()) return toast('Type a complaint first');
    const { ms } = addComplaints([[$('#oneChannel').value, text]]);
    const c = state.complaints[state.complaints.length - 1];
    $('#preview').innerHTML = `Triaged in ${ms.toFixed(1)} ms → <strong>${esc(T.DEPARTMENTS[c.dept].label)}</strong>
      <span class="badge ${c.level}">${LEVEL_LABEL[c.level]} ${c.urgency}</span> · ${esc(T.LANGS[c.lang])} · ${esc(c.station || 'station unknown')}
      <div class="row"><button class="btn btn-sm" type="button" data-open="${c.id}">Open</button></div>`;
    $('#oneText').value = '';
  };
  $('#preview').onclick = (e) => { const id = e.target.dataset.open; if (id) openDetail(id); };

  $('#addBatch').onclick = () => {
    const items = parseBatch($('#batchText').value);
    if (!items.length) return toast('Paste at least one complaint');
    const { count, ms } = addComplaints(items);
    $('#batchResult').textContent = `Triaged ${count} complaint(s) on-device in ${ms.toFixed(1)} ms.`;
    $('#batchText').value = '';
    switchTab('board');
  };
  $('#batchFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    $('#batchText').value = await f.text();
    e.target.value = '';
  };
  const loadSamples = () => {
    const { count, ms } = addComplaints(window.SAMPLE_COMPLAINTS);
    toast(`Triaged ${count} sample complaints in ${ms.toFixed(1)} ms — no network used`);
    switchTab('board');
  };
  $('#loadSamples').onclick = loadSamples;
  $('#loadSamplesEmpty').onclick = loadSamples;

  // ---------- Wiring ----------
  function switchTab(name) {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    if (name === 'sync') { renderSync(); refreshHq(); checkLlm(); }
  }
  $$('.tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

  const openFrom = (e) => { const el = e.target.closest('[data-id]'); if (el) openDetail(el.dataset.id); };
  $('#board').onclick = openFrom;
  $('#critical').onclick = openFrom;
  $('#board').onkeydown = (e) => { if (e.key === 'Enter') openFrom(e); };
  ['#search', '#fLevel', '#fLang', '#fStatus'].forEach((s) => $(s).addEventListener('input', renderBoard));
  $('#fLang').innerHTML += Object.entries(T.LANGS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');

  $('#syncBtn').onclick = () => trySync(true);
  $('#forceOffline').onchange = (e) => {
    state.settings.forceOffline = e.target.checked; save(KEY.settings, state.settings);
    addLog(e.target.checked ? 'Network simulated OFF' : 'Network simulated ON');
    renderNet(); renderSync();
    if (!e.target.checked) trySync();
  };
  $('#refreshHq').onclick = refreshHq;
  $('#clearHq').onclick = async () => {
    if (!confirm('Reset the HQ store on the server?')) return;
    try { await fetch('/api/hq', { method: 'DELETE' }); refreshHq(); } catch { toast('HQ unreachable'); }
  };
  $('#clearLocal').onclick = () => {
    const n = Object.keys(state.outbox).length;
    if (!confirm(n ? `${n} record(s) have not synced yet and will be lost. Clear anyway?` : 'Clear all complaints on this device?')) return;
    state.complaints = []; state.outbox = {}; persist(); render();
  };
  $('#llmCheck').onclick = checkLlm;
  $('#llmModel').onchange = (e) => { state.settings.model = e.target.value.trim(); save(KEY.settings, state.settings); };

  let toastTimer;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  render();
  checkLlm();
  trySync();
})();
