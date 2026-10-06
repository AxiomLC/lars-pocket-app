# BUILDREADME — lars-pocket-app

The plan to replace the LiveKit voice leg of **lars15** with the proven **browser
voice pipeline** from the pocket-tts app, wired straight into the **Hermes profile
RPC websocket** — no LiveKit, no `:8642` REST API needed. All locally researched
against the installed Hermes v0.21.5 source on this machine (2026-09-24).

---

## 1. What we are building

A single FastAPI/Express app — **lars-pocket-app** — that gives the user a
**lars15-style HUD** (as a UI *template only*) with the **pocket-tts browser voice
stack** (mic on/off, re-arm, barge-in, semi-streaming chat, Pocket TTS), where the
**conversation runs on a REAL live Lars Hermes session** via the
`hermes serve` JSON-RPC/WebSocket gateway.

**Scope: streamline hard — voice chat to Lars FIRST.** The local-resource
cosmetic panels (Models Loadout, Voice Link, Turn Metrics, Diagnostics) and the
Kanban/Dashboard iframes are **NOT wired in for v1** — render them as static
placeholders in the stolen lars15 UI so the layout looks right, then the user
fines-tunes the UI after the voice works. lars15's own typing box is kept.

Pipeline (browser-driven, no SFU / agent worker):

```
Chrome (armed mic, barge-in)
  │  Web Speech STT → transcript
  ▼
[ lars-pocket-app server ]  /api/chat (streaming SSE)
  │  connects to Hermes WS:  /api/ws (JSON-RPC 2.0)  → session.create → prompt.submit
  ▼
Hermes live session `lars` (same one the desktop uses) → message.delta events → SSE
  ▼
[ server ] sentence-chunk the reply
  ▼
POST /api/tts {text} → Pocket TTS (uvx pocket-tts serve) → chunked WAV
  ▼
Web Audio gapless playback (mic re-opens = barge-in)
```

---

## 2. Repos / projects involved

| Repo / dir | Role | Status |
|---|---|---|
| `C:\Users\Admin\lars15` | Current Lars web app. **LiveKit voice leg is broken/miswired** (browser targets dead `ws://127.0.0.1:7880` while config = cloud; session id doesn't transfer). Text side + HUD panels + Hermes bridge code are good and portable. | Old; source of ideas/HUD/plugin |
| `C:\Users\Admin\lars-pocket-tts` | Original standalone pocket-tts harness (owns `public/` frontend: armed mic, barge-in, semi-streaming, TTS). GitHub `AxiomLC/lars-pocket-tts`. **Working browser stack but raw Groq brain and no live Hermes session.** | Old; source of voice frontend. Superseded |
| `C:\lars-pocket-app` | **THIS project.** Fresh build = lars15 HUD stylings/panels + pocket-tts voice frontend + Hermes WS brain. | New |
| `~/.hermes` / `AppData\Local\hermes\hermes-agent` | Installed Hermes v0.21.5. Runs `hermes serve` (WS gateway, default :9119) and `hermes gateway run` (REST API, :8642). Profile `lars` lives here. | Runtime dependency (already installed) |

---

## 3. Architecture of the old app — what we are DELETING vs KEEPING

### lars15 (LiveKit leg) — DELETE
- `server/agent_worker.py` — LiveKit agent worker (dead skill mode, session id mismatch).
- `voice_token` / `set_livekit` / LiveKit imports / `:8642`-only wiring.
- Any HUD code that points at `ws://127.0.0.1:7880` or the LiveKit cloud WS.
- The broken `voice link error: could not establish signal connection` retry loop.

### lars15 — KEEP (steal the whole custom HUD)
- `server/hud/index.html` — the **entire custom HUD** (dark sci-fi styling + layout) including the **Kanban**, **Hermes Dashboard**, **Dashboard Chat** iframe boxes — all kept (they're part of the appeal) plus the typing box.
- `server/hud/*` — any other assets the HUD pulls.
- The **typing box** — kept working (sends the same text to Hermes as the voice does).
- `hermes-plugin/hud_display` — the **full plugin** (`hud_display`/`hud_dismiss`, `toolset="hud"`) kept and wired; we teach the Lars profile to use the HUD and these tools.
- **Disconnected:** the left/right **local resource param/diagnostic wires** (Models Loadout, Voice Link, Turn Metrics, Diagnostics) — leave them rendered (placeholders) but do NOT wire the data feeds.

> **OLD REPS ARE READ-ONLY**: `AxiomLC/lars-pocket-tts` is a **working beta — DO NOT touch**. We borrow (and here build on) its `public/` voice frontend pattern only. (Prior accidental deprecation-push reverted to `37b80de`.)

### UI controls (from the pocket-tts app)
- **Mic button (on/off)** for voice chat — toggle starts/stops the conversation mic.
- **"re-arm" button** next to the mic — explicitly re-open the mic after a turn / to keep talking, as in the pocket-tts app.

### pocket-tts app — KEEP (this is the working voice core)
- `public/index.html`, `public/app.js`, `public/state.js`, `public/style.css`
- Armed-mic, barge-in (`speaking → listening` on interrupt), sentence-chunked streaming TTS, echo defence — **all browser-side and already proven working.**

---

## 4. HOW A BROWSER APP ACTUALLY CONNECTS TO HERMES (verified against v0.21.5 source + live probe)

### The one fact that matters
A browser app talks to a live Hermes profile over the **`hermes serve`
JSON-RPC/WebSocket gateway**, on its **natural port `:9119`**. The desktop GUI
and your custom web app **connect to the *same* gateway and share the *same*
sessions** — a second client simply attaches to the same session id. This is the
normal, supported path. **No static `:8643`, no separate port, and no `:8642` REST
server is needed.**

- `:9119` = `hermes serve` (the WS gateway the desktop app and remote clients connect to). **Use this.**
- `:8642` = `hermes gateway run` REST API. **Not needed** for a live chat app (and not on by default).

### The route that drives live profile chat: `/api/ws` (JSON-RPC 2.0)
**`/api/ws`** (`hermes_cli/web_routers/chat_ws.py` → `tui_gateway.ws.handle_ws` →
`server.dispatch`) is the gateway sidecar the desktop Ink chat and the dashboard
render through. It binds to the **same session id as the terminal chat**, so a
message you send from the browser shows up / answers on the real profile session.

**Wire protocol (JSON-RPC 2.0 over text frames):**
- On connect you receive `{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready",...}}`.
- **Send** a user turn: `{"jsonrpc":"2.0","id":N,"method":"session.create",...}`
  (or `session.resume`/`session.most_recent` to attach to an existing session),
  then `{"jsonrpc":"2.0","id":N,"method":"prompt.submit","params":{...text...}}`.
- **Streaming chat deltas** arrive as `{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta",...}}`
  (also `reasoning.delta`, `thinking.delta`). Translate these → OpenAI-SSE.
- **Barge-in / stop:** `session.interrupt`.
- Useful methods on the surface: `session.create/resume/list/most_recent/interrupt/compress`,
  `prompt.submit/background/btw`, `command.dispatch`, `slash.exec`, `voice.tts/record/toggle`.

### Connection recipe (Phase 2 code)
1. Open `ws://127.0.0.1:9119/api/ws` (loopback `?token=` auth) — see auth below.
2. Await `gateway.ready`.
3. `session.create` (or `session.most_recent`/`session.resume` to join the live Lars session).
4. `prompt.submit` with the user's speech text.
5. Stream `message.delta` → SSE; `session.interrupt` for barge-in.

### Auth (gate mode determines it) — VERIFIED live 2026-10
`_ws_auth_mode()` returns `gated` | `insecure` | `loopback`.
- **loopback** (default localhost bind): an external WS client **MUST pass
  `?token=_SESSION_TOKEN`** — verified: no token and wrong token were both
  rejected; only the matching token got `gateway.ready`. (The browser dashboard
  *looks* token-free only because the page auto-injects the token.)
- **Token source**: `HERMES_DASHBOARD_SESSION_TOKEN` **env var**, read at startup
  (`web_server.py`: `os.environ.get(...) or secrets.token_urlsafe(32)`). NOT in
  config.yaml. Our `.env` `HERMES_TOKEN` must match the value the `:9119`
  process was started with.
- **This machine**: Startup VBS `Hermes_Dashboard.vbs` launches
  `hermes dashboard --port 9119 --host 127.0.0.1 --no-open` with
  `HERMES_DASHBOARD_SESSION_TOKEN=lars-voice-bridge-2026` — our `.env` matches.
- **gated** (`auth_required`): mint a single-use 30 s ticket via
  `POST /api/auth/ws-ticket`, send `?ticket=`; re-mint on reconnect.
Close codes on `/api/*` chat routes if rejected: `4401` bad auth, `4403`
host/origin mismatch, `4404` embedded chat disabled (on by default),
`4408` peer not allowed. The `/api/ws` sidecars close `4403`/`4401` on the same gates.

### "Two Gateways" — confirmed (official docs)
Two adjacent-but-separate surfaces, per hermes-agent docs:
1. **The API server** on `:8642` — optional OpenAI-compatible HTTP endpoint,
   `API_SERVER_ENABLED=false` by default, needs `API_SERVER_KEY`. CLI via
   `hermes gateway run`. This machine's config.yaml does **NOT** enable it.
2. **The messaging gateway** — auto-starts with Hermes (desktop-managed,
   restartable in the desktop UI, shows in desktop logs). It is the single
   background process that connects messaging platforms, **handles sessions,
   runs cron jobs every 60 s, delivers voice messages**. Confirmed running here
   as `hermes gateway run` (PID 26316) parented by the desktop app.
Our local web app needs neither — we go over `:9119` `/api/ws` JSON-RPC, which
reaches the live session/cron/messaging world through the desktop gateway.

---

## 5. Proof — Web UIs talking to Hermes over the WS gateway

The same `/api/ws` JSON-RPC gateway is exactly what Hermes' own **bundled
dashboard SPA** and the **Electron desktop GUI** use to drive profile chat — both
are "Web UI talking to Hermes over WS". We replicate that same client contract.
Authoritative proofs (all on this machine, Hermes v0.21.5):

- `hermes serve --help` — "the JSON-RPC/WebSocket gateway the desktop app and remote clients connect to".
- Source: `hermes_cli/web_routers/chat_ws.py` (`/api/ws` → `handle_ws`),
  `tui_gateway/ws.py` (JSON-RPC read loop, `gateway.ready`, `_STREAMING_EVENT_TYPES`),
  `tui_gateway/server.py` (the `@method(...)` RPC surface: `session.*`, `prompt.*`, `voice.*`).
- Hermes is a private/local package, so the source + CLI help above are the real
  proof; the external reference for the browser STT/TTS half is the working
  `AxiomLC/lars-pocket-tts` README (mic → STT → LLM → TTS voice loop).

---

## 6. CONFIRMED BUILD ORDER (confident, validated)

Do in this order. Each step ends runnable/testable.

**Phase 0 — Scaffold (this repo) — DONE (build doc + git + .env.example + package.json)**
1. Init git in `C:\lars-pocket-app`; repo = `AxiomLC/lars-pocket-app` (already pushed).
2. `package.json` (`type: module`, `start: node --env-file=.env server.js`), `.gitignore` (`.env`, `node_modules/`, `logs/`), `.env` + `.env.example` (PORT, Hermes WS URL, POCKET_*).

**Build order = OPTION B: wire the Hermes brain FIRST on the as-is pocket-tts voice chassis, THEN dump the custom HUD on top.**
Get the risky/new piece (Hermes RPC) proven on the smallest, already-working surface before layering the cosmetic HUD on it.

**Phase 1 — Bring over the working pocket-tts voice chassis (as-is)**
3. Copy pocket-tts `public/{index.html,app.js,state.js,style.css}` + `server.js` skeleton into this app; keep its voice stack (mic on/off, re-arm, barge-in, semi-streaming, Pocket TTS) working and Groq-backed for now.
4. Confirm the as-is round-trips on this repo (voice -> Groq -> TTS) before touching anything else.

**Phase 2 — The Hermes WS brain (the critical new code) — swap Groq -> Hermes /api/ws JSON-RPC**
5. Write a small Hermes WS client in `server.js` (replace the Groq `/api/chat` body, keep the OpenAI-style SSE shape `app.js` already parses):
   - connect `ws://127.0.0.1:9119/api/ws` (`?token=` on loopback, or ticket if gated),
   - await `gateway.ready`; `session.create` (or `session.most_recent` to join the live Lars session),
   - `prompt.submit` with the user's text; translate `message.delta` events → `data: {choices:[{delta:{content}}]}`;
   - `session.interrupt` for barge-in; re-open/re-auth on drop.
6. Test headless first: tiny script opens the WS and sends a prompt; confirm a Lars reply streams back. Then in-browser: **voice -> Lars (live Hermes session) -> TTS** round-trip.

**V1 acceptance = voice chat to a LIVE Lars session round-trips** (speak -> Lars replies aloud on the real Hermes session, barge-in works, typing box shares the same session). Everything cosmetic comes after.

**Phase 3 — THEN dump the whole custom HUD on top**
7. Port lars15 `server/hud/index.html` (+ assets) into this app; keep the voice panel mic on/off + re-arm; keep typing box.
8. Render the **cosmetic diagnostic panels** (Models Loadout, Voice Link, Turn Metrics, Diagnostics) as **static placeholders** — disconnect their data wires; no psutil, no `:8642` proxy, no LiveKit stubs. Optional later: real feeds.
9. Implement the **whole `hud_display` plugin**: register it in the Lars profile, add the Kanban / Hermes Dashboard / Dashboard Chat iframe boxes to the HUD, re-point `hud_display`'s `SUMMON_URL` from the old `:8765` to this app, add `/api/summon` here, wire `/api/events` (or a local event feed) to drive the popup iframes, and teach the profile to call these.

**Phase 4 — LLM speed lever (later)**
10. Because the frontend speaks OpenAI-style SSE, the LLM brain is swappable. To use **Cerebras gpt-oss-120b**, either route Hermes' profile to a Cerebras upstream, or bypass Hermes with a direct Cerebras chat-completions call — swap URL/key/model in the `/api/chat` adapter only. No UI change.

**Phase 5 — Cleanup (do NOT touch old repos)**
11. Delete/leave inert the LiveKit worker + `:7880`/cloud WS wiring *inside this app's own code*. **Do not modify or re-push `AxiomLC/lars-pocket-tts`** (working beta).

---

## 7. Open questions to confirm at build time (not blockers)
- **Auth mode of the running gateway:** loopback (`?token=`) or gated (ticket)? Check `hermes serve`'s first log line. Handles both. For loopback we start it with `HERMES_DASHBOARD_SESSION_TOKEN` set so our server knows the token.
- **Is `hermes serve` actually bound on `:9119`?** Earlier netstat showed only `:8642` (gateway run), not `:9119`. If the desktop GUI isn't currently holding `:9119`, `hermes serve` on `:9119` is fine and is the preferred target — no separate port. If `:9119` is taken, fall back to `hermes serve --port 0` and read the printed port (still no fixed static port in code).
- **Profile name** — confirm `lars` (profile dir `AppData\Local\hermes\profiles\lars` exists ✓).
- **Chat path:** `/api/ws` JSON-RPC (NOT `/api/console` — that's a command console, not chat; NOT `/api/pty` — needs WSL2).
- **Pocket TTS port** — currently `:1133` (or whatever another app used); the app auto-starts its own via `uvx pocket-tts serve` unless one is already up.

---

## 8. Quick reference — useful commands

```cmd
::: start the Hermes WS gateway (the app and desktop share this; :9119 is its natural port)
::   hermes serve --port 9119          (or --port 0 and read the printed port)
::   set HERMES_DASHBOARD_SESSION_TOKEN first to pin the loopback ?token= value

:: start Pocket TTS (if not already running)
uvx pocket-tts serve --port 1133

:: run this app
cd C:\lars-pocket-app
npm start        # node --env-file=.env server.js

:: sanity
netstat -ano | findstr :9119 :1133 :PORT
curl http://127.0.0.1:9119/health            # hermes ws gateway (http probe)
curl http://127.0.0.1:1133/health            # pocket tts
curl http://localhost:PORT/api/config        # this app
```

---

## 9. Status tracker
- [x] Phase 0 — scaffold repo + git + build doc (done)
- [ ] Phase 1 — port pocket-tts voice frontend (mic on/off, re-arm) + server
- [ ] Phase 2 — Hermes WS brain (`/api/ws` JSON-RPC: session.* + prompt.submit) — **critical path**
- [ ] Phase 3 — HUD skins/panels + `hud_display`/`/api/summon` re-wiring
- [ ] Phase 4 — Cerebras LLM lever (later)
- [ ] Phase 5 — deprecate LiveKit path

---

## 10. Hermes WS build reference (load-bearing facts — do not re-derive)

Researched 2026-10 by reading the installed v0.21.5 source and probing a live
gateway. These are the facts a build session needs; keep them in one place.

### What `hermes serve` is & where to connect
- The **JSON-RPC/WebSocket gateway the desktop app and remote clients connect to** (verbatim from `hermes serve --help`).
- Natural/default port **`9119`**. Use it. **No static `:8643` and no `:8642`.**
- `:8642` = the REST API from `hermes gateway run` — separate, not needed, and not on by default.
- The desktop GUI and your web app connect to the **same** gateway and can share/attach to the **same** session.

### The chat route: `/api/ws` (JSON-RPC 2.0) — NOT `/api/console`
- **`/api/ws`** (`chat_ws.py` → `tui_gateway.ws.handle_ws` → `server.dispatch`) is the **real live-profile chat sidecar**. It binds the same session id the desktop Ink chat uses.
- **`/api/console`** is a **Hermes Command Console** (a CLI), not conversational chat — sending natural language got "Unsupported Hermes Console command". **Do not use it for chat.**
- **`/api/pty`** needs WSL2 on Windows — skip.
- **`/api/pub` + `/api/events`** fan out tool/agent events on a channel — useful later for HUD summons (Phase 3).

### RPC method surface (from `tui_gateway/server.py` `@method(...)`)
Session + prompt (the Phase 2 core): `session.create`, `session.resume`, `session.list`, `session.most_recent`, `session.interrupt`, `session.compress`, `session.control`, `session.title`, `prompt.submit`, `prompt.background`, `prompt.btw`, `command.dispatch`, `slash.exec`. Voice helpers exist too: `voice.tts`, `voice.record`, `voice.toggle`.

### Wire protocol
- Connect → server sends `{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready",...}}`.
- Client sends `{"jsonrpc":"2.0","id":N,"method":"<method>","params":{...}}`; server replies with a same-`id` `result`/`error`.
- Streaming chat deltas: `{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta",...}}` (`_STREAMING_EVENT_TYPES = {message.delta, reasoning.delta, thinking.delta}`).
- Heartbeat: `{"jsonrpc":"2.0","id":N,"method":"gateway.ping"}` → `{"result":{"ok":true}}`.

### Auth (gate mode decides)
- `_ws_auth_mode()`: `loopback` (default localhost) | `gated` (`auth_required`) | `insecure` (non-loopback bind).
- **loopback**: pass `?token=<_SESSION_TOKEN>`; pin it by launching `hermes serve` with `HERMES_DASHBOARD_SESSION_TOKEN` set.
- **gated**: `POST /api/auth/ws-ticket` → single-use 30 s ticket → `?ticket=`; re-mint on reconnect.
- Reject close codes: `4401` bad auth, `4403` host/origin mismatch, `4404` embedded chat disabled (on by default), `4408` peer not allowed.

### Frontend contract (unchanged from pocket-tts)
- `app.js` already parses **OpenAI-style SSE**: `data: {choices:[{delta:{content}}]}` … `data: [DONE]`. The server adapter translates Hermes `message.delta` events into that shape. This is ALSO what makes the Cerebras sidecar a drop-in (same SSE shape).

### Profile + helpers
- Profile name = `lars` (profile dir `C:\Users\Admin\AppData\Local\hermes\profiles\lars` exists).
- Tickets are single-use, 30 s TTL → on a WS drop, re-mint per reconnect.

---

## 11. Brain-routing toggle: Hermes Lars profile **vs** Cerebras sidecar

Two chat backends behind ONE `/api/chat` (both emit the same OpenAI-SSE shape),
selected by a `BRAIN=hermes|cerebras` env switch, exposed as `GET /api/config → brain`.
Default v1 = **Hermes Lars profile** (full brain, skills, memory, HUD tools); the
alternative = a **lightweight direct-Cerebras path** measured for latency.

**Decision on shape (user + agent, updated):** the toggle *code* is not fragile
(both legs share the SSE contract). The fragile part is the Hermes leg (getting
into the live profile session). So: build the two legs as swappable functions now,
but **prove the Hermes leg first**. If the live-session connect stays flaky after
real validation, the toggle is mostly moot and the **Cerebras leg becomes a
companion app in its own repo** (tested on its own), rather than an in-app toggle.
We will decide after Phase 2 proves (or doesn't) the Hermes path.

### Why a Cerebras sidecar (the user's rationale)
- Test raw **latency** of the voice→gpt-oss-120b→TTS loop with no Hermes-profile overhead (no skills auto-load, no heavy memory, no platform routing).
- A **lightweight prompt + minimal skills** compared to going through the Hermes profile.
- **Persist via Hermes as needed:** the sidecar can write a **truncated memory** to Hermes and **tool-call a Hermes memory** on demand — async/pull, not in the hot path.

### Design sketch (code-level)
- **Switch:** `BRAIN=hermes|cerebras` in `.env`; exposed as `GET /api/config` → `brain` so the UI can show/select it. `server.js` holds two chat backends behind one `POST /api/chat` :
  ```js
  // /api/chat — same OpenAI-SSE output shape whatever the brain
  const brain = env.BRAIN || "hermes";
  if (brain === "cerebras")   return streamCerebras(req,res,text);   // direct chat-completions SSE
  else                        return streamHermesProto(res,text);   // /api/ws JSON-RPC -> translate
  ```
- **Cerebras backend** (`streamCerebras`): fetch `https://api.cerebras.ai/v1/chat/completions` with `stream:true`, `model: gpt-oss-120b`, the **HUD/HUD-plugin prompt** + a short [user]+tools context, pipe the `data:` SSE straight through (it already matches `app.js`). Truncate history (`HISTORY_TURNS`) like pocket-tts does.
- **Hermes persistence (async, not hot-path):** after a sidecar turn, optionally `POST` a one-line summary into the `lars` profile session (or a Hermes memory endpoint) so the real profile stays aware; and if the sidecar needs real Hermes data, it can call a Hermes memory/tool once — guarded so it never blocks the voice loop.
- **Minimal tool calls for the sidecar:** allow a small allowlist (e.g. the HUD/Kanban display + a Hermes memory read) by calling the Hermes `/api/events`/tool surface out-of-band; the UI already renders those as panels/iframes.

### Full env for the toggle app (nothing sensitive — beta keys get rotated)
```dotenv
# --- app ---
PORT=1122
ENV=dev

# --- brain switch ---
BRAIN=hermes                # hermes | cerebras

# --- Hermes leg (loopback gateway on its natural port) ---
HERMES_WS_URL=ws://127.0.0.1:9119/api/ws
HERMES_TOKEN=lars-pocket-dev-token   # must equal HERMES_DASHBOARD_SESSION_TOKEN the gateway was started with
HERMES_PROFILE=lars
# gated mode instead: HERMES_TICKET_URL=http://127.0.0.1:9119/api/auth/ws-ticket

# --- Cerebras leg (only used when BRAIN=cerebras) ---
CEREBRAS_API_KEY=
CEREBRAS_MODEL=gpt-oss-120b
CEREBRAS_URL=https://api.cerebras.ai/v1/chat/completions

# --- shared voice config (from pocket-tts) ---
POCKET_URL=http://localhost:1133/tts
POCKET_VOICE=af_heart
POCKET_CMD=uvx pocket-tts serve --port 1133
GROQ_MODEL=llama-3.1-8b-instant   # legacy fallback only
SYSTEM_PROMPT=Reply briefly.
HISTORY_TURNS=6
MAX_TOKENS=200
```
All optional except `PORT`. The Hermes leg is the default; Cerebras needs only
`HERMES_*` left blank + `CEREBRAS_API_KEY`/`CEREBRAS_MODEL` set.

> **Not in v1 scope** — the toggle is designed now, built after Phase 2/3 prove the Hermes path. But the SSE-front contract makes it a focused, low-risk addition.

---

## 12. Execution handoff (for a fresh build session)

If this chat is compacted, start the build from this repo's README. The one-line plan:

> Build in `AxiomLC/lars-pocket-app` (local `C:\lars-pocket-app`). **Option B**: bring the pocket-tts voice chassis in as-is (Phase 1) → swap Groq for the Hermes `/api/ws` JSON-RPC brain (`session.*` + `prompt.submit`, on the gateway's own `:9119` — not `/api/console`, not `:8643`, not `:8642`; see §10 facts) and prove a live Lars streaming voice round-trip → only then dump the whole lars15 HUD + `hud_display` plugin + Kanban/Dashboard/Chat boxes on top (Phase 3). `lars-pocket-tts` is READ-ONLY (working beta, `37b80de`) — never touch. Later: Cerebras sidecar toggle (§11) + cleanup LiveKit (§Phase 5).
