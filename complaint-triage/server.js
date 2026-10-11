/*
 * Sunvai server — zero dependencies.
 *  - Serves the station app (public/index.html) and the control-centre console (public/admin.html).
 *  - /api/sync            POST  station devices push complaints; response carries control-centre edits + policy back.
 *  - /api/config          GET   current policy (SLA targets, extra routing keywords) for devices.
 *  - /api/admin/*               control-centre console (password protected).
 *  - /api/llm, /api/llm/health  optional proxy to a local Ollama (Gemma) — no internet needed.
 *
 * Usage: node server.js   (env or .env: PORT, ADMIN_PASSWORD, OLLAMA_URL, OLLAMA_MODEL)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Load settings from .env next to this file (real environment variables take precedence).
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const PORT = Number(process.env.PORT) || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'gemma4';
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STORE = path.join(DATA_DIR, 'hq.json');

const DEFAULT_CONFIG = {
  version: 1,
  slaMinutes: { critical: 15, high: 240, medium: 1440, low: 4320 },
  customTerms: { safety: [], lifts: [], fare: [], staff: [], cleanliness: [], general: [] },
  updatedAt: 0,
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// ---------- Store ----------
function loadStore() {
  let s;
  try { s = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { s = {}; }
  s.records ||= {}; s.syncs ||= []; s.devices ||= {}; s.audit ||= [];
  s.config = { ...DEFAULT_CONFIG, ...(s.config || {}) };
  return s;
}
function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE);
}
function audit(store, actor, action, detail) {
  store.audit.unshift({ at: Date.now(), actor, action, detail });
  store.audit = store.audit.slice(0, 500);
}

// ---------- Admin sessions (in memory; restart = log in again) ----------
const sessions = new Map();
const SESSION_MS = 12 * 3600e3;
function checkAuth(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- HTTP helpers ----------
function readBody(req, limit = 4_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) { const b = await readBody(req); return b ? JSON.parse(b) : {}; }
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function mergeHistory(a = [], b = []) {
  const seen = new Set();
  return [...a, ...b].filter((h) => { const k = `${h.at}|${h.type}|${h.text}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => x.at - y.at);
}

const DEPTS = Object.keys(DEFAULT_CONFIG.customTerms);
const STATUSES = ['open', 'in-progress', 'resolved'];

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') return json(res, 200, { ok: true, time: Date.now() });

  if (p === '/api/config' && req.method === 'GET') return json(res, 200, loadStore().config);

  // Station devices push their changes and pull control-centre edits made since `since`.
  if (p === '/api/sync' && req.method === 'POST') {
    const { device, profile, records = [], since = 0 } = await readJson(req);
    if (!device || !Array.isArray(records)) return json(res, 400, { error: 'device and records[] required' });
    const store = loadStore();
    const now = Date.now();
    const accepted = [];
    for (const r of records) {
      if (!r || typeof r.id !== 'string') continue;
      const existing = store.records[r.id];
      if (!existing) {
        store.records[r.id] = { ...r, device, receivedAtHq: now };
      } else if ((r.updatedAt || 0) >= (existing.updatedAt || 0)) {
        // Device wins on fields, but control-centre notes/escalations it hasn't seen yet are kept.
        store.records[r.id] = {
          ...r, device, receivedAtHq: existing.receivedAtHq, hqUpdatedAt: existing.hqUpdatedAt,
          escalated: existing.hqUpdatedAt ? existing.escalated : r.escalated,
          history: mergeHistory(existing.history, r.history),
        };
      }
      accepted.push({ id: r.id, updatedAt: r.updatedAt });
    }
    const updates = Object.values(store.records).filter((r) => r.device === device && (r.hqUpdatedAt || 0) > since);
    store.devices[device] = {
      ...(store.devices[device] || {}), device, lastSeen: now,
      name: profile?.name || store.devices[device]?.name || '', station: profile?.station || store.devices[device]?.station || '',
      lastPush: records.length ? now : store.devices[device]?.lastPush,
    };
    if (records.length) {
      store.syncs.unshift({ at: now, device, count: accepted.length });
      store.syncs = store.syncs.slice(0, 200);
    }
    saveStore(store);
    return json(res, 200, { accepted, updates, config: store.config, serverTime: now });
  }

  if (p === '/api/admin/login' && req.method === 'POST') {
    const { password } = await readJson(req);
    if (!safeEqual(password || '', ADMIN_PASSWORD)) return json(res, 401, { error: 'Incorrect password' });
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, Date.now() + SESSION_MS);
    const store = loadStore(); audit(store, 'admin', 'login', 'Signed in to the control centre'); saveStore(store);
    return json(res, 200, { token });
  }

  if (p.startsWith('/api/admin/') || p === '/api/hq') {
    if (!checkAuth(req)) return json(res, 401, { error: 'Sign in required' });
  }

  if (p === '/api/admin/logout' && req.method === 'POST') {
    sessions.delete((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    return json(res, 200, { ok: true });
  }

  if ((p === '/api/admin/state' || p === '/api/hq') && req.method === 'GET') {
    const store = loadStore();
    return json(res, 200, {
      records: Object.values(store.records), devices: Object.values(store.devices),
      syncs: store.syncs.slice(0, 100), audit: store.audit.slice(0, 200), config: store.config, serverTime: Date.now(),
    });
  }

  // Control-centre edit on one complaint: department, status, escalation, note.
  const m = p.match(/^\/api\/admin\/complaints\/([\w-]+)$/);
  if (m && req.method === 'PATCH') {
    const store = loadStore();
    const r = store.records[m[1]];
    if (!r) return json(res, 404, { error: 'Complaint not found' });
    const { dept, status, escalated, note, actor = 'Control centre' } = await readJson(req);
    const now = Date.now();
    const events = [];
    r.history ||= [];
    if (dept && DEPTS.includes(dept) && dept !== r.dept) {
      events.push({ type: 'rerouted', text: `Control centre moved it from ${r.dept} to ${dept}` });
      r.dept = dept; r.overridden = true; r.confidence = 1;
    }
    if (status && STATUSES.includes(status) && status !== r.status) {
      events.push({ type: 'status', text: `Control centre set status to ${status}` });
      r.status = status;
      if (status === 'resolved') r.resolvedAt = now;
      if (status === 'in-progress') r.ackAt ||= now;
      if (status === 'open') r.resolvedAt = null;
    }
    if (typeof escalated === 'boolean' && escalated !== !!r.escalated) {
      events.push({ type: 'escalation', text: escalated ? 'Escalated by control centre' : 'Escalation cleared by control centre' });
      r.escalated = escalated;
    }
    if (typeof note === 'string' && note.trim()) events.push({ type: 'note', text: note.trim().slice(0, 2000) });
    if (!events.length) return json(res, 200, { record: r });
    for (const e of events) r.history.push({ at: now, by: actor, hq: true, ...e });
    r.updatedAt = now; r.hqUpdatedAt = now;
    audit(store, actor, 'complaint', `${r.id}: ${events.map((e) => e.type === 'note' ? 'note added' : e.text).join('; ')}`);
    saveStore(store);
    return json(res, 200, { record: r });
  }

  if (p === '/api/admin/config' && req.method === 'PUT') {
    const store = loadStore();
    const { slaMinutes, customTerms } = await readJson(req);
    const next = { ...store.config };
    if (slaMinutes) for (const k of Object.keys(DEFAULT_CONFIG.slaMinutes)) {
      const v = Math.round(Number(slaMinutes[k]));
      if (Number.isFinite(v) && v >= 1 && v <= 60 * 24 * 30) next.slaMinutes = { ...next.slaMinutes, [k]: v };
    }
    if (customTerms) {
      next.customTerms = {};
      for (const d of DEPTS) next.customTerms[d] = [...new Set((customTerms[d] || []).map((t) => String(t).trim().toLowerCase()).filter((t) => t.length >= 2 && t.length <= 40))].slice(0, 100);
    }
    next.version = (store.config.version || 1) + 1;
    next.updatedAt = Date.now();
    store.config = next;
    audit(store, 'admin', 'policy', `Policy updated to version ${next.version}`);
    saveStore(store);
    return json(res, 200, next);
  }

  if (p === '/api/admin/reset' && req.method === 'POST') {
    const store = loadStore();
    const fresh = { records: {}, syncs: [], devices: {}, audit: [], config: store.config };
    audit(fresh, 'admin', 'reset', 'Cleared all complaints and device records');
    saveStore(fresh);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/llm/health') {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
      const { models = [] } = await r.json();
      return json(res, 200, { available: true, models: models.map((x) => x.name), defaultModel: DEFAULT_MODEL });
    } catch {
      return json(res, 200, { available: false, models: [], defaultModel: DEFAULT_MODEL });
    }
  }

  if (p === '/api/llm' && req.method === 'POST') {
    const { model, messages } = await readJson(req);
    try {
      const r = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || DEFAULT_MODEL, messages, stream: false, format: 'json', options: { temperature: 0.2 } }),
        signal: AbortSignal.timeout(90_000),
      });
      const data = await r.json();
      if (!r.ok) return json(res, 502, { error: data.error || `Ollama returned ${r.status}` });
      return json(res, 200, { content: data.message?.content || '' });
    } catch (e) {
      return json(res, 503, { error: `Local model unavailable: ${e.message}` });
    }
  }

  return json(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    json(res, e instanceof SyntaxError ? 400 : 500, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`Sunvai station app     → http://localhost:${PORT}`);
  console.log(`Control centre console → http://localhost:${PORT}/admin`);
  console.log(ADMIN_PASSWORD === 'admin123'
    ? 'Admin password: admin123 (default; set ADMIN_PASSWORD to change it)'
    : `Admin password: set via ADMIN_PASSWORD${fs.existsSync(ENV_FILE) ? ' (.env)' : ''}`);
  console.log(`Local AI (optional): ${OLLAMA_URL}  model: ${DEFAULT_MODEL}`);
});
