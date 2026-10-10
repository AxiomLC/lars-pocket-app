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
   SUMMON CHANNEL — Server-Sent Events feed to every open HUD.
   The Hermes `hud_display` tool POSTs to /api/summon; we broadcast a
   `summon_panel` / `dismiss_panels` SSE event to all connected HUDs,
   which render a Holo Panel. Zero dependencies (plain node http).
   ===================================================================== */
const hudClients = new Set();
function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}
function broadcastSummon(payload) {
  const buf = [];
  hudClients.forEach((res, i) => {
    buf.push(i);
    try { sseWrite(res, 'summon_panel', payload); } catch { hudClients.delete(res); }
  });
  console.log(`[hud] summon broadcast to ${buf.length} HUD screen(s)`);
}
function broadcastDismiss() {
  let n = 0;
  hudClients.forEach(res => {
    try { sseWrite(res, 'dismiss_panels', {}); n++; } catch { hudClients.delete(res); }
  });
  console.log(`[hud] dismiss broadcast to ${n} HUD screen(s)`);
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
        hermesOnEvent('message.delta', params);
      } else if (type === 'message.complete') {
        hermesOnEvent('message.complete', params);
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

// ---- Turn-scoped streaming relay ----
// Each /api/chat call gets a `turn`. Incoming message.delta / message.complete are
// routed to whichever turn is CURRENTLY running. A per-turn token guards against
// the barge-in overlap where stale events from an interrupted turn would otherwise
// resolve a brand-new turn's promise or get pushed into its stream.
let curTurn = null;          // { id, push, promise:{resolve}, interruptSent }
let larsSessionId = null;
let settleUntil = 0;         // drop inbound events briefly after session.interrupt
let lastDeltaAt = 0;         // when the last message.delta arrived (for drain detection)
let interruptAt = 0;         // when the most recent session.interrupt was sent

const HLOG = path.join(__dir, 'logs', 'server.log');
function hlog(line) { try { fs.appendFileSync(HLOG, `[${new Date().toISOString()}] ${line}\n`); } catch {} }

/** Route one streaming event (message.delta / message.complete) to the live turn. */
function hermesOnEvent(type, params) {
  const deltaText = params?.payload?.text;
  if (typeof deltaText === 'string' && type === 'message.delta') {
    lastDeltaAt = Date.now();                    // even a registered-stale delta means "still draining"
    if (Date.now() < settleUntil) { hlog(`event dropped (settle): ${deltaText.slice(0,40)}`); return; }
    const t = curTurn;
    if (!t) { hlog(`message.delta dropped (no live turn): ${deltaText.slice(0,40)}`); return; }
    t.push(deltaText);
  } else if (type === 'message.complete') {
    if (Date.now() < settleUntil) { hlog('message.complete dropped (settle)'); return; }
    const t = curTurn;
    if (!t) { hlog('message.complete dropped (no live turn)'); return; }
    // End this turn when it produced real spoken content OR genuinely ran and completed
    // (its deltas may have been entirely tool-narration filtered out of speech). A stale
    // complete for a turn that never saw a delta (fresh turn, nothing yet) still won't
    // truncate it — see sawRaw.
    if (t.chars > 0 || t.sawRaw > 0) t.promise.resolve();
    else hlog(`message.complete ignored for empty turn (sawRaw=${t.sawRaw})`);
  }
}

// The live Lars session we attach to (created fresh, cached across turns so the
// app owns one continuous conversation; most_recent returns a stale api_server row).
async function getOrCreateSession() {
  if (larsSessionId) return larsSessionId;
  const c = await hermesRpc('session.create', { title: `voice-${Date.now()}`, profile: HERMES_PROFILE });
  larsSessionId = c?.result?.session_id || null;
  if (!larsSessionId) console.warn('[hermes] session.create failed:', JSON.stringify(c?.error));
  return larsSessionId;
}

// Strip things Lars never means to be HEARD: tool-call JSON, <HUD DISPLAY>/HTML tags,
// thinking/reasoning markers, and lone tool names. Keeps the spoken stream clean without
// dropping real prose. (TTS gets the result; the chat bubble may still show raw content.)
function cleanSpokenText(raw) {
  if (!raw) return '';
  let t = String(raw);
  // <HUD DISPLAY>...</HUD DISPLAY> or any <...> markup
  t = t.replace(/<HUD[^>]*>[\s\S]*?<\/HUD>|<[^>]+>/gi, ' ');
  // JSON tool-call blocks / raw tool JSON literals
  t = t.replace(/\{\s*"tool"[\s\S]*?\}/gi, ' ');
  t = t.replace(/\{\s*"name"[\s\S]*?\}/gi, ' ');
  // known tool-call narration + interim comms prefixes
  t = t.replace(/\b(?:hud_display|hud_dismiss|web_search|browser_navigate)\b[\s,]*/gi, ' ');
  // markdown/URL noise
  t = t.replace(/`+|```+/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

// Turn relay: collect message.delta into an SSE stream; end on message.complete.
function streamHermesChat(req, res, messages) {
  const userText = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  let done = false;
  const close = () => { if (!done) { done = true; if (curTurn?.id === turn.id) curTurn = null; } };
  const endStream = () => { if (done) return; res.write('data: [DONE]\n\n'); close(); res.end(); };

  // Per-turn promise + relay (registered as the current turn).
  const turn = {
    id: hermesSeq++, chars: 0, sawRaw: 0,
    push(text) {
      this.sawRaw++;                       // any delta of THIS turn (even if filtered out of speech)
      const clean = cleanSpokenText(text);
      // Only forward a delta to the spoken stream if it contains real deliverable text.
      if (!clean) return;
      this.chars += clean.length;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: clean } }] })}\n\n`);
    },
    promise: null,
  };
  let turnComplete;
  turn.promise = { resolve: () => {} };
  const completePromise = new Promise(r => { turn.promise.resolve = r; });
  curTurn = turn;

  (async () => {
    try {
      const sid = await getOrCreateSession();
      if (!sid) throw new Error('could not obtain a Hermes session');
      // After a barge-in interrupt, wait for the aborted turn to drain (no deltas for
      // ~500ms, capped at ~3s) so its leftover tail doesn't mix into this new turn.
      if (interruptAt && Date.now() - interruptAt < 3000) {
        const quietMs = 500;
        while (Date.now() - lastDeltaAt < quietMs) {
          if (Date.now() - interruptAt > 3000) break;
          await new Promise(r => setTimeout(r, 100));
        }
        hlog(`drained after interrupt (quiet since ${Date.now() - lastDeltaAt}ms)`);
      }
      hlog(`submit: ${JSON.stringify(userText).slice(0, 80)} (turn ${turn.id})`);
      const r = await hermesRpc('prompt.submit', { session_id: sid, text: userText }, 60000);
      hlog(`prompt.submit result: ${JSON.stringify(r?.result || r?.error || 'none').slice(0, 200)}`);
      if (r?.error) throw new Error(r.error.message || 'prompt.submit failed');
      await Promise.race([completePromise, new Promise(r => setTimeout(r, 30000))]);
      hlog(`turn ${turn.id} complete, chars=${turn.chars}`);
      endStream();
    } catch (e) {
      hlog(`turn ${turn.id} error: ${e.message}`);
      console.warn('[hermes]', e.message);
      endStream();
    }
  })();

  // Client barge-in / disconnect -> interrupt the live turn, drain it, then allow
  // the next prompt.submit to actually run (avoids a fresh turn being orphaned while
  // Hermes is still draining the interrupted one).
  res.on('close', () => {
    if (done) return;
    close();
    if (hermesReady && hermesWs?.readyState === 1) {
      try {
        hermesWs.send(JSON.stringify({ jsonrpc: '2.0', id: hermesSeq++, method: 'session.interrupt', params: {} }));
        hlog(`session.interrupt sent (turn ${turn.id} aborted)`);
      } catch {}
    }
    // Briefly drop inbound events so stale deltas/completes from this aborted turn
    // don't leak into whatever the user says next.
    settleUntil = Date.now() + 1200;
    interruptAt = Date.now();
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

    // --- HUD summon channel: 1) an open HUD subscribes to the SSE stream, ---
    // --- 2) the Hermes hud tool posts here and we fan the event out.       ---
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      hudClients.add(res);
      req.on('close', () => hudClients.delete(res));
      return; // stream stays open — never call res.end() here
    }

    if (req.method === 'POST' && req.url === '/api/summon') {
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch {}
      if (body.action === 'dismiss') broadcastDismiss();
      else broadcastSummon({
        media: body.media || 'iframe',
        src: body.src || '',
        title: (body.title || 'INCOMING FEED'),
        position: ['left', 'right', 'center'].includes(body.position) ? body.position : 'center',
      });
      return sendJson(res, 200, { ok: true, sent_to: hudClients.size });
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

    // --- HUD embed proxy: let Holo Panels iframe external pages that would otherwise
    // --- refuse framing via X-Frame-Options / CSP frame-ancestors. We fetch server-side
    // --- and re-serve WITHOUT those headers (mirrors jarvis_ai's original :9443 proxy).
    // --- GET /api/embed?url=<encoded target>&title=<optional>
    if (req.method === 'GET' && req.url.startsWith('/api/embed?')) {
      const u = new URL(req.url, 'http://x');
      const target = u.searchParams.get('url') || '';
      if (!/^https?:\/\//i.test(target)) return sendJson(res, 400, { error: 'embed requires an http(s) url' });
      try {
        const up = await fetch(target, { signal: AbortSignal.timeout(15000), redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
        const status = up.status;
        const type = up.headers.get('content-type') || 'text/html';
        const body = await up.arrayBuffer();
        res.writeHead(status, {
          'Content-Type': type,
          'Cache-Control': 'no-cache',
          // deliberately ABSENT: X-Frame-Options and CSP frame-ancestors (so the HUD can frame it)
        });
        res.end(Buffer.from(body));
      } catch (e) { sendJson(res, 502, { error: `embed fetch failed: ${e.message}` }); }
      return;
    }

    let f = path.join(__dir, 'public', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    // If the URL resolves to a directory (e.g. `/hud/`), serve its index.html.
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
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
