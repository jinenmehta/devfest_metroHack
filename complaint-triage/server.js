/*
 * Zero-dependency local server for the PS-07 prototype.
 *  - Serves the PWA from ./public (the app keeps working from its service-worker cache if this stops).
 *  - /api/sync     POST  : "HQ" endpoint — merges triaged complaints (last-write-wins on updatedAt).
 *  - /api/hq       GET   : what HQ has received so far.
 *  - /api/llm      POST  : optional proxy to a local Ollama (Gemma) — still fully offline.
 *  - /api/llm/health GET : is a local model available?
 *
 * Usage: node server.js   (PORT, OLLAMA_URL, OLLAMA_MODEL env vars are optional)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 8080;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'gemma4';
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STORE = path.join(DATA_DIR, 'hq.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return { records: {}, syncs: [] }; }
}
function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, time: new Date().toISOString() });

  if (url.pathname === '/api/sync' && req.method === 'POST') {
    const { device, records } = JSON.parse(await readBody(req));
    if (!Array.isArray(records)) return json(res, 400, { error: 'records[] required' });
    const store = loadStore();
    const accepted = [];
    for (const r of records) {
      if (!r || typeof r.id !== 'string') continue;
      const existing = store.records[r.id];
      if (!existing || (r.updatedAt || 0) >= (existing.updatedAt || 0)) store.records[r.id] = { ...r, receivedAt: Date.now(), device };
      accepted.push({ id: r.id, updatedAt: r.updatedAt });
    }
    store.syncs.push({ at: Date.now(), device, count: accepted.length });
    store.syncs = store.syncs.slice(-50);
    saveStore(store);
    return json(res, 200, { accepted, serverTime: Date.now() });
  }

  if (url.pathname === '/api/hq' && req.method === 'GET') {
    const store = loadStore();
    return json(res, 200, { records: Object.values(store.records), syncs: store.syncs });
  }

  if (url.pathname === '/api/hq' && req.method === 'DELETE') {
    saveStore({ records: {}, syncs: [] });
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/llm/health') {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
      const { models = [] } = await r.json();
      return json(res, 200, { available: true, models: models.map((m) => m.name), defaultModel: DEFAULT_MODEL });
    } catch {
      return json(res, 200, { available: false, models: [], defaultModel: DEFAULT_MODEL });
    }
  }

  if (url.pathname === '/api/llm' && req.method === 'POST') {
    const { model, messages } = JSON.parse(await readBody(req));
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
    json(res, 500, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`Every Complaint Heard → http://localhost:${PORT}`);
  console.log(`Local LLM (optional): ${OLLAMA_URL}  model: ${DEFAULT_MODEL}`);
});
