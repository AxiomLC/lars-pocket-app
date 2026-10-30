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
import net from 'node:net';
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

const unknownEv = {};       // distinct WS event kinds seen (first-3 logged) for compaction/notice discovery
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
      // Log unseen event kinds (compaction/notices/session lineage) so a real
      // compaction or session-rotation signal becomes identifiable in server.log.
      // First 3 occurrences per type only — thinking.delta etc. must not flood it.
      if (type) {
        unknownEv[type] = (unknownEv[type] || 0) + 1;
        if (unknownEv[type] <= 3) hlog(`event: ${type} ${JSON.stringify(params).slice(0, 220)}`);
      }
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
let lastTtfsMs = null;       // prompt.submit -> first spoken delta (LARS SESSION panel)

// Per-model context caps (tokens) for the context-load bar. Extend as models change.
const CTX_CAPS = { 'gpt-oss-120b': 131072 };

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
//
// v0.22.5 streams tool-call JSON INLINE in message.delta text, chunked (segment/offset),
// glued to interim narration ("Just a moment…{\"tool\":...}}"). A per-chunk regex can't
// match a partial JSON (no closing brace), so cleanSpokenStream() buffers until braces
// balance, drops complete tool-call blocks, and retracts the narration glued before them.
const NARR_LOOKBACK = 32; // chars of lookback kept un-emitted so narration before a tool call can be retracted
const TOOL_JSON_RE = /^\{\s*"(tool|name)"/;
// Interim narration phrases Hermes glues before an inline tool-call JSON ("Just a moment…{\"tool\":…").
// Built from an array so the alternation stays balanced. Only applied right before a stripped tool block.
const NARRATION_PHRASES = [
  'just a moment', 'one moment', 'give me a moment', 'okay,? checking',
  'okay, checking that', 'okay, checking on that',
  'checking that', 'checking on that',
  'let me check', 'let me see', 'let me look', 'let me find', 'let me search',
  'let me verify', 'let me confirm', 'let me pull', 'let me open', 'let me get',
  'let me grab', 'let me fetch', 'let me try', 'let me think', 'let me look up',
  'let me check on', 'let me check that', 'let me see if', 'let me check if',
  'let me look that up', 'let me find that', 'let me pull that up', 'let me open that',
  'let me get that', 'let me look at', 'let me check the', 'let me open the',
  'let me pull up the', 'let me find the', 'let me get the', 'let me see the',
  'let me look up the', 'let me find out', 'let me look into', 'let me investigate',
  'let me take a look', 'let me have a look', 'let me look for', 'let me check for',
  'let me search for', 'let me see what', 'let me find out what', 'let me check on the',
  'let me pull up', 'let me open up', 'let me find me', 'let me show me',
  'let me look into the', 'let me check on that', 'let me see about',
  'let me look at the', 'let me check the status',
];
const NARRATION_RE = new RegExp(`(?:\\b(?:${NARRATION_PHRASES.join('|')})\\b|hmm+|um+|uh+)[….,:;!? ]*$`, 'i');

function cleanSpokenStream(text, st, flush = false) {
  st.pending += text;
  let out = '';
  while (st.pending.length) {
    const open = st.pending.indexOf('{');
    if (open === -1) {
      // No JSON in flight: emit all but a short lookback tail (so narration glued
      // to a tool call in the NEXT chunk can still be retracted). Flush = emit all.
      const keep = flush ? 0 : Math.min(st.pending.length, NARR_LOOKBACK);
      out += st.pending.slice(0, st.pending.length - keep);
      st.pending = st.pending.slice(st.pending.length - keep);
      break;
    }
    // Scan from `open` for the matching '}' (brace depth; handles nested parameters).
    let depth = 0, j = -1;
    for (let k = open; k < st.pending.length; k++) {
      const c = st.pending[k];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { j = k; break; } }
    }
    if (j === -1) {
      // Unclosed at chunk end: keep from the lookback window before `{`, emit the rest.
      // On flush (turn end) there is no next chunk to retract narration, so emit up to `{`.
      const keepFrom = flush ? open : Math.max(0, open - NARR_LOOKBACK);
      out += st.pending.slice(0, keepFrom);
      st.pending = st.pending.slice(keepFrom);
      break;
    }
    if (TOOL_JSON_RE.test(st.pending.slice(open, j + 1))) {
      // Tool-call JSON: drop the whole block plus any interim narration glued before it.
      st.pending = st.pending.slice(0, open).replace(NARRATION_RE, '') + st.pending.slice(j + 1);
    } else {
      // Prose that merely contains braces: emit through the closing brace.
      out += st.pending.slice(0, j + 1);
      st.pending = st.pending.slice(j + 1);
    }
  }
  return out;
}

function cleanSpokenText(raw) {
  if (!raw) return '';
  let t = String(raw);
  // <HUD DISPLAY>...</HUD DISPLAY> or any <...> markup
  t = t.replace(/<HUD[^>]*>[\s\S]*?<\/HUD>|<[^>]+>/gi, ' ');
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

  // Only forward a delta to the spoken stream if it contains real deliverable text.
  const emit = (clean) => {
    if (!clean) return;
    if (!turn.firstSpokenAt) {
      turn.firstSpokenAt = Date.now();
      if (turn.submitAt) lastTtfsMs = turn.firstSpokenAt - turn.submitAt;
    }
    turn.chars += clean.length;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: clean } }] })}\n\n`);
  };

  // Per-turn promise + relay (registered as the current turn).
  const turn = {
    id: hermesSeq++, chars: 0, sawRaw: 0,
    submitAt: null, firstSpokenAt: null,
    pending: '',                       // cleanSpokenStream() lookback/JSON buffer
    push(text) {
      this.sawRaw++;                   // any delta of THIS turn (even if filtered out of speech)
      emit(cleanSpokenText(cleanSpokenStream(text, this)));
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
      turn.submitAt = Date.now();
      let r = await hermesRpc('prompt.submit', { session_id: sid, text: userText }, 60000);
      hlog(`prompt.submit result: ${JSON.stringify(r?.result || r?.error || 'none').slice(0, 200)}`);
      // Safety net: stale session id (compaction rotation / ws_orphan_reap / Hermes
      // restart) -> recreate one fresh session and retry this turn exactly once.
      const stale = r?.error && (r.error.code === 4001 || /not found|400?1/i.test(String(r.error.message || '')));
      if (stale) {
        hlog(`session stale (${JSON.stringify(r.error)}) -> recreating session, retrying once`);
        larsSessionId = null;
        const sid2 = await getOrCreateSession();
        if (sid2) {
          turn.submitAt = Date.now();
          r = await hermesRpc('prompt.submit', { session_id: sid2, text: userText }, 60000);
          hlog(`prompt.submit retry: ${JSON.stringify(r?.result || r?.error || 'none').slice(0, 200)}`);
        }
      }
      if (r?.error) throw new Error(r.error.message || 'prompt.submit failed');
      await Promise.race([completePromise, new Promise(r => setTimeout(r, 30000))]);
      // Flush any prose still held in the lookback/JSON buffer (turn ended mid-stream).
      emit(cleanSpokenText(cleanSpokenStream('', turn, true)));
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
   DIAGNOSTICS — real per-process usage of Hermes.exe (+dashboard host) on
   this local. No plugin/prereq: one PowerShell sample, two passes 600ms apart
   for a true CPU% (Get-Process is cumulative), RAM = summed WorkingSet.
   Name filter 'hermes' matches both the desktop Hermes.exe and hermes.exe CLIs.
   Cached 3s so 5s HUD polling can never pile up shell spawns.
   ===================================================================== */
let diagCache = { up: false, cpuPct: 0, ramMb: 0, procs: 0, at: 0 };
let diagBusy = false;
function sampleHermesDiag() {
  return new Promise(resolve => {
    const script = [
      "$p1 = Get-Process -Name hermes -ErrorAction SilentlyContinue",
      "if (-not $p1) { Write-Output '{\"up\":false,\"cpuPct\":0,\"ramMb\":0,\"procs\":0}'; exit }",
      "$c1 = ($p1 | Measure-Object CPU -Sum).Sum",
      "$t1 = Get-Date",
      "Start-Sleep -Milliseconds 600",
      "$p2 = Get-Process -Name hermes -ErrorAction SilentlyContinue",
      "$c2 = ($p2 | Measure-Object CPU -Sum).Sum",
      "$rows = @($p2).Count",
      "$mb = [int](($p2 | Measure-Object WorkingSet64 -Sum).Sum / 1MB)",
      "$secs = ((Get-Date) - $t1).TotalSeconds",
      "$pct = [math]::Max(0, [math]::Round((($c2 - $c1) / [math]::Max($secs, 0.001)) / [Environment]::ProcessorCount * 100, 1))",
      "Write-Output ('{\"up\":true,\"cpuPct\":' + $pct + ',\"ramMb\":' + $mb + ',\"procs\":' + $rows + '}')",
    ].join('; ');
    let done = false;
    const fin = v => { if (!done) { done = true; resolve(v); } };
    try {
      const ps = spawn('powershell', ['-NoProfile', '-Command', script]);
      let out = '';
      ps.stdout.on('data', d => out += d);
      ps.on('close', () => { try { fin(JSON.parse(out.trim())); } catch { fin({ up: false, cpuPct: 0, ramMb: 0, procs: 0 }); } });
      ps.on('error', () => fin({ up: false, cpuPct: 0, ramMb: 0, procs: 0 }));
      setTimeout(() => { try { ps.kill(); } catch {} fin({ up: false, cpuPct: 0, ramMb: 0, procs: 0 }); }, 5000);
    } catch { fin({ up: false, cpuPct: 0, ramMb: 0, procs: 0 }); }
  });
}

/* =====================================================================
   /dash — reverse proxy to the Hermes dashboard (:9119)
   Lets bare KANBAN/CHAT views load SAME-ORIGIN so the HUD can hide the
   dashboard's left menu (#app-sidebar). Two rewrites make the SPA work
   from our origin:
     1. HTML attributes src|href="/x"  ->  "/dash/x"  (resource loads)
     2. an inline shim prefixes runtime absolute URLs in fetch / XHR /
        EventSource / WebSocket / sendBeacon with "/dash".
   Named routes above always win this page's cache of URLs; the static
   fallback below parks anything else (fonts, missed assets) upstream.
   The HERMES DASHBOARD view is NEVER proxied (direct :9119 iframe,
   full menu, zero route clashes).
   ===================================================================== */
const DASH_UP = 'http://127.0.0.1:9119';
const DASH_SHIM = '<script>(function(){var P=function(u){return (typeof u==="string"&&u.charAt(0)==="/"&&u.indexOf("/dash/")!==0)?"/dash"+u:u};'
  // strip our /dash prefix from the LOCATION before the SPA router boots:
  // the route table only knows /kanban, /chat … -> without this it renders nothing.
  + 'try{if(location.pathname.indexOf("/dash/")===0){var z=location.pathname.slice(5)||"/";history.replaceState(null,"",z+location.search+location.hash)}}catch(e){};'
  + 'if(window.fetch){var f=window.fetch.bind(window);window.fetch=function(i,o){return f(typeof i==="string"?P(i):i,o)}};'
  + 'if(window.XMLHttpRequest){var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){var a=Array.prototype.slice.call(arguments);if(typeof a[1]==="string")a[1]=P(a[1]);return o.apply(this,a)}};'
  + 'if(window.EventSource){var E=window.EventSource;window.EventSource=function(u,x){return new E(P(u),x)}};'
  + 'if(window.WebSocket){var W=window.WebSocket;window.WebSocket=function(u,x){if(typeof u==="string"){var m=u.match(/^(wss?:\/\/[^\/]+)(\/.*)?$/);if(m&&m[2]&&m[2].indexOf("/dash/")!==0)u=m[1]+"/dash"+m[2]}return new W(u,x)}};'
  + 'try{if(navigator.sendBeacon){var b=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){return b(P(u),d)}}}catch(e){}'
  + '})();<\/script>';
async function dashProxy(req, res, ac) {
  const tail = req.url.slice('/dash'.length) || '/';
  try {
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    let body;
    if (hasBody) { const cs = []; for await (const c of req) cs.push(c); body = Buffer.concat(cs); }
    const hdrs = {};
    for (const [k, v] of Object.entries(req.headers)) if (!['host', 'connection'].includes(k)) hdrs[k] = v;
    hdrs.host = '127.0.0.1:9119';
    const up = await fetch(DASH_UP + tail, {
      method: req.method, signal: ac.signal, redirect: 'manual',
      headers: hdrs, ...(hasBody ? { body } : {}),
    });
    const hy = Object.fromEntries(up.headers);
    delete hy['content-encoding']; delete hy['content-length'];   // undici already decoded the body
    if (hy.location && String(hy.location).startsWith('/')) hy.location = '/dash' + hy.location;  // keep redirects inside the proxy
    const ct = String(up.headers.get('content-type') || '');
    if (ct.includes('text/html')) {
      let text = await up.text();
      text = text.replace(/(src|href)=(['"])\/(?!\/)(?!dash\/)/g, (m, a, q) => a + '=' + q + '/dash/');   // 1. resources (lambda: $-tokens proved unreliable here)
      if (text.includes('</head>')) text = text.replace(/<head[^>]*>/i, m => m + DASH_SHIM);  // 2. runtime shim (first in head)
      else text = DASH_SHIM + text;
      res.writeHead(up.status, hy); res.end(Buffer.from(text, 'utf8')); return;
    }
    res.writeHead(up.status, hy);
    if (req.method === 'HEAD') return res.end();
    Readable.fromWeb(up.body).pipe(res);
  } catch (e) {
    if (e.name === 'AbortError') { try { res.end(); } catch {} return; }
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'dash proxy: ' + e.message })); }
    else try { res.end(); } catch {}
  }
}

/* =====================================================================
   HTTP ROUTES
   ===================================================================== */
const server = http.createServer(async (req, res) => {
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
        brain: BRAIN, profile: BRAIN === 'hermes' ? HERMES_PROFILE : null, pocketUrl: POCKET_URL, voice: E.POCKET_VOICE || 'alba', pocketUp,
        hermesUrl: BRAIN === 'hermes' ? HERMES_WS_ORIGIN : undefined,
      });
    }

    // --- LARS SESSION panel: our live session merged with Hermes /api/sessions (REST :9119) ---
    if (req.method === 'GET' && req.url === '/api/session/stats') {
      const out = {
        ok: true, sessionId: larsSessionId, profile: HERMES_PROFILE, model: null,
        turns: 0, tokIn: 0, tokOut: 0, ctxPct: null, cap: null, ttfsMs: lastTtfsMs,
      };
      try {
        const token = await discoverHermesToken();
        const r = await fetch(`${HERMES_WS_ORIGIN}/api/sessions?profile=${encodeURIComponent(HERMES_PROFILE)}&limit=50`, {
          headers: { 'X-Hermes-Session-Token': token || '' }, signal: AbortSignal.timeout(4000),
        });
        const list = (await r.json()).sessions || [];
        // Our live session by id; fallback = newest session this app created (title voice-<ts>).
        let mine = list.find(s => larsSessionId && s.id === larsSessionId)
          || list.filter(s => String(s.title || '').startsWith('voice-'))
                 .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0];
        if (mine) {
          out.model = mine.model || null;
          out.profile = mine.profile || HERMES_PROFILE;
          out.turns = Math.ceil((mine.message_count || 0) / 2);
          out.tokIn = mine.input_tokens || 0;
          out.tokOut = mine.output_tokens || 0;
          out.cap = CTX_CAPS[mine.model] || null;
          if (out.cap) {
            // Hermes sums input over API calls -> per-request context ~= (in + cache_read)/calls + avg out.
            const calls = Math.max(1, mine.api_call_count || 1);
            const ctx = Math.round((out.tokIn + (mine.cache_read_tokens || 0)) / calls) + Math.round(out.tokOut / calls);
            out.ctxPct = Math.min(100, Math.round(ctx / out.cap * 100));
          }
        }
      } catch (e) { out.ok = false; out.error = String(e.message || e); }
      return sendJson(res, 200, out);
    }

    // --- DIAGNOSTICS panel: Hermes.exe-only CPU/RAM (cached 3s, see sampleHermesDiag) ---
    if (req.method === 'GET' && req.url === '/api/hermes/diag') {
      if (Date.now() - diagCache.at < 3000 || diagBusy) return sendJson(res, 200, diagCache);
      diagBusy = true;
      diagCache = { ...await sampleHermesDiag(), at: Date.now() };
      diagBusy = false;
      return sendJson(res, 200, diagCache);
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
    if (!f.startsWith(path.join(__dir, 'public')) || !fs.existsSync(f)) {
      // Not ours: park it on the dashboard (proxied /dash pages use root-absolute
      // URLs my shim didn't catch: fonts, images, missed assets). Named routes
      // above always win, so a dashboard /api/chat or /api/config only reaches
      // ours if the HTML shim failed to prefix it — accepted, conscious trade.
      return dashProxy(req, res, ac);
    }
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[path.extname(f)] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (e.name === 'AbortError' || res.headersSent) return res.end();
    const refused = /fetch failed|ECONNREFUSED/.test(String(e) + String(e.cause));
    sendJson(res, 500, { error: refused ? 'Upstream not reachable (Pocket TTS still loading?)' : e.message });
  }
});

// --- WS relay: a proxied dashboard page opening /dash/api/ws (it XHRs its own
// --- origin, the shim prefixes the path) is piped straight into :9119.
server.on('upgrade', (req, socket, head) => {
  try {
    const target = (req.url || '/').replace(/^\/dash/, '') || '/';
    const up = net.connect(9119, '127.0.0.1', () => {
      const hdrs = Object.entries(req.headers)
        .filter(([k]) => !['host', 'connection'].includes(k))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n');
      up.write(`${req.method} ${target} HTTP/1.1\r\nhost: 127.0.0.1:9119\r\n${hdrs}\r\n\r\n`);
      if (head && head.length) up.write(head);
      socket.pipe(up); up.pipe(socket);
    });
    up.on('error', () => { try { socket.destroy(); } catch {} });
    socket.on('error', () => { try { up.destroy(); } catch {} });
  } catch { try { socket.destroy(); } catch {} }
});

server.listen(PORT, () => console.log(`lars-pocket-app → http://localhost:${PORT}  (brain=${BRAIN}, open in Chrome)`));
