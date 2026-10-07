// lars-pocket-app — one launcher. Serves the (pocket-tts) voice UI and routes chat
// to ONE of two brains behind a single OpenAI-SSE shape the frontend already parses:
//   BRAIN=hermes    -> live Hermes Lars profile session (default) via /api/ws JSON-RPC
//   BRAIN=cerebras  -> direct Cerebras LLM (scaffold) for A/B latency
// Voice/TTS/static come straight from the pocket-tts chassis (reuse Pocket if up).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const E = process.env;
const PORT = +E.PORT || 1122;
const POCKET_URL = E.POCKET_URL || 'http://localhost:1133/tts';
const POCKET_BASE = new URL(POCKET_URL).origin;
const BRAIN = (E.BRAIN || 'hermes').toLowerCase();

// --- Hermes leg config (default; auto-discovers token from the :9119 page) ---
const HERMES_WS_ORIGIN = (E.HERMES_WS_ORIGIN || 'http://127.0.0.1:9119').replace(/\/$/, '');
const HERMES_PROFILE = E.HERMES_PROFILE || 'lars';

// ---- Pocket TTS: reuse it if it is already up, otherwise start it ----
let child;
const pocketIsUp = async () => {
  try { return (await fetch(POCKET_BASE + '/health', { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
};
(async () => {
  if (await pocketIsUp()) { console.log(`[pocket-tts] already running at ${POCKET_BASE}, reusing it`); return; }
  if (!E.POCKET_CMD) { console.log(`[pocket-tts] not running and POCKET_CMD is blank. Start it yourself.`); return; }
  child = spawn(E.POCKET_CMD, { shell: true, stdio: 'inherit' });
  child.on('exit', c => console.log(`[pocket-tts] exited (${c})`));
  console.log(`[pocket-tts] started it: ${E.POCKET_CMD}`);
})();
const bye = () => {
  try {
    if (child && process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else child?.kill();
  } catch {}
  process.exit();
};
process.on('SIGINT', bye); process.on('SIGTERM', bye);

const readBody = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); });
const sendJson = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
function pipeReadableTo(res, source, headers) {
  res.writeHead(200, { 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', ...headers });
  const s = Readable.fromWeb(source.body ?? source);
  s.on('error', () => res.end());
  s.pipe(res);
}

// Self-pruning mirror of the browser log panel: keeps only the newest 200 lines.
const UI_LOG = path.join(__dir, 'logs', 'ui.log');
const UI_LOG_LINES = 200;
function appendUiLog(line) {
  try {
    let lines = [];
    try { lines = fs.readFileSync(UI_LOG, 'utf8').split(/\r?\n/); } catch {}
    lines.push(line);
    if (lines.length > UI_LOG_LINES) lines.splice(0, lines.length - UI_LOG_LINES);
    fs.writeFileSync(UI_LOG, lines.join('\n') + '\n');
  } catch {}
}

/* =====================================================================
   HERMES LEG — /api/ws JSON-RPC -> OpenAI-SSE
   Auto-discovers the session token from the dashboard page, keeps one
   persistent WS, and uses the live Lars session. The frontend posts the
   full history each time; Hermes sessions are persistent, so we send only
   the latest user message as a new prompt.submit turn.
   ===================================================================== */
let hermesWs = null;      // persistent WebSocket
let hermesReady = false;  // gateway.ready received
let hermesSeq = 1;
const pending = new Map(); // id -> resolve for gateway.ping/result

async function discoverHermesToken() {
  try {
    const res = await fetch(`${HERMES_WS_ORIGIN}/`, { signal: AbortSignal.timeout(3000) });
    const html = await res.text();
    const m = html.match(/window\.__HERMES_SESSION_TOKEN__="([^"]*)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

function wsUrl(token) {
  const q = new URLSearchParams({ token });
  return `${HERMES_WS_ORIGIN.replace(/^http/, 'ws')}/api/ws?${q}`;
}

function connectHermes() {
  if (hermesWs) return;
  discoverHermesToken().then(token => {
    if (!token) { console.warn('[hermes] no token found on dashboard page'); return; }
    const ws = new WebSocket(wsUrl(token));
    hermesWs = ws;
    ws.onopen = () => console.log('[hermes] ws open');
    ws.onmessage = ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      // RPC response (has an id) -> resolve the pending caller.
      if (j.hasOwnProperty('id')) {
        const cb = pending.get(j.id);
        if (cb) { pending.delete(j.id); cb(j); }
        return;
      }
      const params = j.params || {};
      const type = params.type || '';
      // Streaming chat chunks: message.delta -> text lives in params.payload.text.
      if (type === 'message.delta' && typeof params?.payload?.text === 'string') {
        hermesOnDelta(params.payload.text);
      } else if (type === 'message.complete') {
        hermesOnComplete();
      } else if (type === 'gateway.ready') {
        hermesReady = true;
        console.log('[hermes] gateway.ready');
      }
      // other event kinds (thinking.delta, reasoning.delta, tool.*, etc.) are ignored
    };
    ws.onerror = () => {};
    ws.onclose = () => { hermesReady = false; hermesWs = null; };
  });
}

function hermesRpc(method, params, timeoutMs = 10000) {
  return new Promise((resolve) => {
    connectHermes();
    const id = hermesSeq++;
    const t = setTimeout(() => { pending.delete(id); resolve({ error: { message: 'hermes rpc timeout', code: -1 } }); }, timeoutMs);
    pending.set(id, (resp) => { clearTimeout(t); resolve(resp); });
    const send = () => { try { hermesWs.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); } catch { pending.delete(id); resolve({ error: { message: 'hermes ws not open' } }); } };
    if (hermesReady && hermesWs && hermesWs.readyState === 1) send();
    else { const target = setInterval(() => { if (hermesReady && hermesWs && hermesWs.readyState === 1) { clearInterval(target); send(); } }, 100); setTimeout(() => clearInterval(target), timeoutMs); }
  });
}

// Active turn: the streaming relay + abort for barge-in.
let activeTurn = null;
function hermesOnDelta(text) {
  if (!activeTurn) return;
  activeTurn.push(text);
}
function hermesOnComplete() {
  if (activeTurn && activeTurn.promise) activeTurn.promise.resolve();
}
// The live Lars session we attach to (created fresh, cached across turns so the
// app owns one continuous conversation; most_recent returns a stale api_server row).
let larsSessionId = null;
async function getOrCreateSession() {
  if (larsSessionId) return larsSessionId;
  // Pass the profile so the session runs under the lars profile (not default).
  const c = await hermesRpc('session.create', { title: `voice-${Date.now()}`, profile: HERMES_PROFILE });
  larsSessionId = c?.result?.session_id || null;
  if (!larsSessionId) console.warn('[hermes] session.create failed:', JSON.stringify(c?.error));
  return larsSessionId;
}

// Turn relay: collect message.delta into an SSE stream; end on message.complete.
function streamHermesChat(req, res, messages, ac) {
  const userText = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const sink = {
    push(text) { if (!text) return; res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text } }] })}\n\n`); },
  };
  activeTurn = sink;
  let done = false;
  const close = () => { if (!done) { done = true; activeTurn = null; } };
  // Resolve when message.complete arrives (or fallback on RPC return / timeout).
  let turnComplete;
  const completePromise = new Promise(r => { turnComplete = r; });
  activeTurn.promise = { resolve: turnComplete };
  const endStream = () => { if (done) return; res.write('data: [DONE]\n\n'); close(); res.end(); };

  (async () => {
    try {
      const sid = await getOrCreateSession();
      if (!sid) throw new Error('could not obtain a Hermes session');
      const r = await hermesRpc('prompt.submit', { session_id: sid, text: userText }, 60000);
      if (r?.error) throw new Error(r.error.message || 'prompt.submit failed');
      // Wait for message.complete or an 30s safety timeout, then close.
      await Promise.race([completePromise, new Promise(r => setTimeout(r, 30000))]);
      endStream();
    } catch (e) {
      console.warn('[hermes]', e.message);
      endStream();
    }
  })();

  // Client barge-in / disconnect -> interrupt the live turn.
  res.on('close', () => {
    if (done) return;
    close();
    if (hermesReady && hermesWs?.readyState === 1) {
      try { hermesWs.send(JSON.stringify({ jsonrpc: '2.0', id: hermesSeq++, method: 'session.interrupt', params: {} })); } catch {}
    }
  });
}

/* =====================================================================
   CEREBRAS LEG — direct OpenAI-style chat-completions (scaffold/placeholder)
   Same SSE shape; uses the minimal HUD/agent prompt. For A/B latency.
   ===================================================================== */
function streamCerebras(req, res, messages) {
  const trimmed = messages.slice(-(+E.HISTORY_TURNS || 6) * 2);
  const hudPrompt = E.CEREBRAS_SYSTEM_PROMPT || E.SYSTEM_PROMPT ||
    'You are Lars, a compact voice assistant using a HUD. Reply briefly and conversationally.';
  if (!E.CEREBRAS_API_KEY) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '[cerebras] CEREBRAS_API_KEY not set in .env — set it and BRAIN=cerebras.' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  fetch(E.CEREBRAS_URL || 'https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST', signal: ac.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${E.CEREBRAS_API_KEY}` },
    body: JSON.stringify({ model: E.CEREBRAS_MODEL || 'gpt-oss-120b', stream: true,
      messages: [{ role: 'system', content: hudPrompt }, ...trimmed] }),
  }).then(up => {
    if (!up.ok) throw new Error(`cerebras ${up.status}`);
    return pipeReadableTo(res, up, { 'Content-Type': 'text/event-stream' });
  }).catch(e => {
    if (e.name === 'AbortError') return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `[cerebras] ${e.message}` } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

/* =====================================================================
   HTTP ROUTES
   ===================================================================== */
http.createServer(async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    // Mirror the browser UI's log panel to a self-pruning file for AI/debugging.
    if (req.method === 'POST' && req.url === '/api/log') {
      let line = '';
      try { line = JSON.parse(await readBody(req)).line || ''; } catch {}
      if (line) appendUiLog(line);
      res.writeHead(204); return res.end();
    }

    if (req.method === 'GET' && req.url === '/api/config') {
      let pocketUp = false;
      try { pocketUp = (await fetch(POCKET_BASE + '/health', { signal: AbortSignal.timeout(800) })).ok; } catch {}
      return sendJson(res, 200, {
        host: `${os.cpus()[0]?.model || '?'}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM, node ${process.version}`,
        brain: BRAIN, pocketUrl: POCKET_URL, voice: E.POCKET_VOICE || 'alba', pocketUp,
        hermesUrl: BRAIN === 'hermes' ? HERMES_WS_ORIGIN : undefined,
      });
    }

    if (req.method === 'POST' && req.url === '/api/chat') {
      const { messages } = JSON.parse(await readBody(req));
      if (!Array.isArray(messages)) return sendJson(res, 400, { error: 'messages array required' });
      if (BRAIN === 'cerebras') return streamCerebras(req, res, messages);
      return streamHermesChat(req, res, messages, ac);  // default: hermes leg
    }

    if (req.method === 'POST' && req.url === '/api/tts') {
      const { text } = JSON.parse(await readBody(req));
      const form = new FormData();
      form.append('text', text);
      // voice_url on pocket-tts must be an http(s):// or hf:// URL to a voice
      // conditioning file (custom voice clone). A bare name (e.g. "alba") is
      // rejected with 400 "voice_url must start with http://...". If POCKET_VOICE
      // isn't a real URL, omit it and let the server use its built-in voice.
      const v = (E.POCKET_VOICE || '').trim();
      if (/^(https?:\/\/|hf:\/\/)/i.test(v)) form.append('voice_url', v);
      const upstream = await fetch(POCKET_URL, { method: 'POST', body: form, signal: ac.signal });
      if (!upstream.ok) return sendJson(res, 502, { error: `Pocket TTS ${upstream.status}: ${(await upstream.text()).slice(0, 200)}` });
      return pipeReadableTo(res, upstream, { 'Content-Type': 'audio/wav' });
    }

    const f = path.join(__dir, 'public', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!f.startsWith(path.join(__dir, 'public')) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[path.extname(f)] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (e.name === 'AbortError' || res.headersSent) return res.end();
    const refused = /fetch failed|ECONNREFUSED/.test(String(e) + String(e.cause));
    sendJson(res, 500, { error: refused ? 'Upstream not reachable (Pocket TTS still loading?)' : e.message });
  }
}).listen(PORT, () => console.log(`lars-pocket-app → http://localhost:${PORT}  (brain=${BRAIN}, open in Chrome)`));
