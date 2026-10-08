# BUILDREADME — lars-pocket-app

Authoritative build doc for **lars-pocket-app** (local `C:\lars-pocket-app`, GitHub
`AxiomLC/lars-pocket-app`, branch `main`). Covers the **working beta v1.0 as it stands NOW**
(pre-HUD) and the plan to lay the jarvis_ai HUD on top. A separate human-facing `README.md`
comes after the UI build.

---

## 1. What this app is (current, working beta v1.0)

A single-node (Express) web app on **`http://localhost:1122`** that delivers **two-way voice
chat to a live Hermes `lars` profile session**:

- **STT** — in-browser (Web Speech API). No server.
- **Brain** — Hermes via the **`:9119` JSON-RPC/WebSocket gateway** (`/api/ws`), default `BRAIN=hermes`.
- **TTS** — Pocket TTS on `:1133` (uvx), served through our `/api/tts` proxy. Built-in `alba` voice.
- **Voice UX** — armed mic (on/off), **re-arm toggle**, **barge-in**, sentence-chunked streaming
  playback, and a typing box. All on the current (old) pocket-tts-style UI.

```
Chrome (armed mic, barge-in)
  │  Web Speech STT → transcript
  ▼
[ lars-pocket-app ]  POST /api/chat (OpenAI-SSE)
  │  Hermes leg: /api/ws JSON-RPC → session.create → prompt.submit → message.delta
  ▼
Hermes live session `lars` → SSE → sentence-chunker
  ▼
POST /api/tts {text} → Pocket TTS (:1133) → chunked WAV → Web Audio gapless playback
```

### Brain toggle (already coded)
One `POST /api/chat` emits OpenAI-SSE; the brain is swappable via `BRAIN` in `.env`:
- `BRAIN=hermes` (default) — live Lars session via `:9119` JSON-RPC.
- `BRAIN=cerebras` — direct Cerebras `gpt-oss-120b` scaffold (placeholder; needs a live key to
  be useful). Same SSE shape, drop-in.

---

## 2. Repos / projects

| Repo / dir | Role | Status |
|---|---|---|
| `C:\lars-pocket-app` | **THIS project.** Working voice→Lars chat; HUD to be laid on top. | **Active** |
| `C:\Users\Admin\lars-pocket-tts` | Original working pocket-tts voice harness; source of our voice frontend pattern. GitHub `AxiomLC/lars-pocket-tts`. | **READ-ONLY** — never touch/push |
| `C:\Users\Admin\lars13` | Local copy of **`eadmin2/jarvis_ai`** (the other dev's repo). Source of the **HUD** (`server/hud/index.html`) + `hermes-plugin/hud_display`. | **Source to copy from** — don't modify |
| Hermes (installed) | Runs `hermes serve` — the `:9119` gateway we connect to. Profile `lars`. | Runtime dep (already up) |

---

## 3. How the app connects to Hermes (verified — do not re-derive)

- **Chat path = `/api/ws` JSON-RPC** on the `:9119` gateway (`hermes serve`). NOT `/api/console`
  (a CLI, not chat), NOT `:8642` (optional OpenAI API server, off by default, not needed).
- **Token auto-discovery:** `GET http://127.0.0.1:9119/` returns HTML containing
  `window.__HERMES_SESSION_TOKEN__="<token>"`. The token is **random per server start** when
  `HERMES_DASHBOARD_SESSION_TOKEN` env is unset → **re-read on every app start and after any
  Hermes restart.** No token → `/api/ws` is rejected (never reaches `gateway.ready`).
- **Session:** use **`session.create`** (`profile=lars`) and **cache the returned `session_id`**
  so the app owns one continuous conversation. **`session.most_recent` is unreliable** (stale
  `api_server` row → error 4001 "session not found"). Do not pass a `surface` param (rejected
  error 4000).
- **Streaming:** `message.delta` events; chunk text is at **`params.payload.text`** (nested
  under `payload`). Turn ends with `message.complete`. Ignore `thinking.delta`/`reasoning.delta`
  for the spoken answer.
- **Barge-in / stop:** `session.interrupt`.

### Two gateways — clarified
- **`:9119`** = `hermes serve` WS gateway — the one our app (and the desktop) use for live chat. ✅
- **`:8642`** = optional OpenAI-compatible API server (`hermes gateway run`). **OFF by default,
  our app does NOT use it.** Side-panel stats come from `:9119` RPC + a local `psutil` call (see §6).

---

## 4. Current state (working beta v1.0) — STABLE SNAPSHOT

Working and verified as of this edit:

- **Full voice round-trip WORKS:** speak → Lars streams a reply → audible via Pocket (`alba`).
- **Pocket TTS `voice_url` fixed (commit `bdf0a68`):** the app was sending the bare Kokoro name
  `af_heart` as Pocket's `voice_url` (must be `http(s)://` or `hf://`). We now only send
  `voice_url` when it's a real URL; otherwise Pocket uses its built-in `alba`. This was the
  original "no audio → barge-in seems dead" root cause.
- **Barge-in reliable over long replies (commit `9a5c95c`):** turn-scoped Hermes streaming — the
  30s-timeout "empty reply from LLM" after a barge-in is fixed, plus a bounded drain gate so an
  interrupted reply's tail doesn't leak into the next answer. Normal turns unaffected.
- **Self-pruning UI-log mirror:** the in-browser log panel also writes `logs/ui.log` (newest 200
  lines) via `POST /api/log`; Hermes turn/event debug goes to `logs/server.log`. Both gitignored.
- **`start.bat`:** starts ONLY our own pieces — Pocket TTS if not listening on `:1133`, `npm start`
  for the UI on `:1122`, opens the browser. **Never touches Hermes** (assumes `:9119` is up).
- **Hermes leg + Cerebras scaffold:** both emit OpenAI-SSE behind one `/api/chat`.

### To run & verify
1. Hermes is up and `:9119` live (app auto-discovers token + connects).
2. `start.bat` (or: `uvx pocket-tts serve --port 1133` + `npm start`) → `http://localhost:1122`.
3. Speak or type → Lars streams a reply (audible via Pocket).

---

## 5. Naming glossary (locked — use exactly these)

| Term | Meaning | File / code |
|---|---|---|
| **HUD** | The whole full-screen UI we're about to lay on top | `public/hud/index.html` |
| **Holo Panel** | A floating iframe pop-up the HUD shows on demand (any content: kanban, dashboard, chat, a web page) | `summonPanel()` / `#holoStage`, `.holo` |
| **Holo Panel M / F** | Medium / Full size variants of a Holo Panel | `position`/size in `summonPanel` |
| **VIEWS dock** | The fixed quick-jump buttons (KANBAN / DASHBOARD / CHAT) in the left column | `openView()` / `#viewer` |
| **summon channel** | The always-open pipe (WS/SSE) the server uses to *push* a Holo Panel to an open HUD | to add: `#/ws` or SSE `/events` |
| **`/api/summon`** | Endpoint Lars (via tool) hits to trigger a Holo Panel | `server.js` |
| **`hud` toolset / `hud_display`** | Hermes-side tools Lars calls to summon/dismiss | `hermes-plugin/hud_display/` (to bring in) |
| **VIEWS content** | Kanban / dashboard / chat iframed from `:9119` | iframes |

---

## 6. HUD UI build (Phase 3) — what it entails

Source: `C:\Users\Admin\lars13\server\hud\index.html` (single 885-line static file) +
`hermes-plugin/hud_display`. We **port the UI**, we do **not** port jarvis_ai's voice/audio stack.

### Sub-phase 3A — shell + VIEWS working (no voice wiring)
1. Copy `hud/index.html` → `public/hud/index.html`, served by our Express server.
   - Disable/remove the PIN auth gate (we're loopback + our app owns auth).
   - Keep the HUD as a separate page (`/hud/`), independent of the current voice page for now.
2. **VIEWS = iframes pointed at `:9119`** — `openView('KANBAN','/kanban')`, DASHBOARD `/`,
   CHAT `/chat`. Confirm `:9119` doesn't frame-block; if it sends `X-Frame-Options`/CSP, strip
   those headers in a small Express proxy route (mirrors what jarvis_ai's `:9443` proxy did, but
   we iframe `:9119` directly — no separate TLS proxy).
3. **Holo Panel summon channel:** add `POST /api/summon` + a lightweight WS/SSE event feed the
   HUD connects to; wire `summonPanel`/`dismissAllPanels` to it. (`/api/pub` + `/api/events` on
   `:9119` may fan events out — reuse if it suits, else a local channel.)
4. **Bring in `hud_display` plugin:** copy `hermes-plugin/hud_display/` into this app; point its
   `SUMMON_URL` at **our** `/api/summon` (env, e.g. `LARS_SUMMON_URL`); register the `hud`
   toolset in the `lars` profile; teach Lars to summon Holo Panels.

### Sub-phase 3B — graft our voice onto the HUD
5. Port our working voice state machine (armed mic on/off, **re-arm button**, barge-in,
   sentence-chunked playback, Pocket TTS) into `hud/index.html`; **replace** jarvis_ai's
   push-to-talk WS audio path. Keep the HUD's animated reactor ring as a **cosmetic state
   indicator** driven by our own `State` machine.
6. Add the **mic on/off** and **re-arm toggle** controls to the HUD's VOICE LINK panel.

### Sub-phase 3C — side panels (data policy)
7. The left/right panels (Models Loadout, Voice Link, Turn Metrics, Diagnostics, Machines,
   SESSION, SKILLS, AUTOMATIONS) will be **populated with OUR OWN data** — not jarvis_ai's wires:
   - **Hermes stats/states/params** (sessions, agents, skills, toolsets, model, activity,
     cron jobs) come from the **`:9119` JSON-RPC** we already hold — no `:8642`.
   - **Local machine CPU/RAM/GPU %** comes from a **small `psutil` endpoint on our own
     `server.js`** (like jarvis_ai's `/api/machines`), since that's the host's stats, not
     Hermes's.
   - **Token/cost** — local tally on our server, or omit.
   - Render as placeholders first, fill them in after the voice + HOLO plumbing is solid.

### Build order note (why 3A before 3B)
Land the risky new plumbing (Holt Panel summon + VIEWS iframes) on the HUD shell first, then move
the already-working voice in. Keeps each step runnable and rollback-safe.

---

## 7. Commands

```cmd
:: start Pocket TTS (if not already listening)
uvx pocket-tts serve --port 1133

:: run this app
cd C:\lars-pocket-app
npm start                       # node --env-file=.env server.js

:: or, one shot (starts TTS if down, runs UI, opens browser)
start.bat

:: sanity
curl http://127.0.0.1:1133/health    # pocket tts
curl http://localhost:1122/api/config # this app (shows brain/voice/pocketUp)
curl http://127.0.0.1:9119/           # hermes gateway (token auto-discover)
```

---

## 8. Status tracker

**Done (beta v1.0, voice → Lars working):**
- [x] Voice round-trip audibly working (Pocket `alba`)
- [x] Barge-in reliable over long replies (turn-scoped streaming + drain gate) — `9a5c95c`
- [x] Pocket TTS `voice_url` fix — `bdf0a68`
- [x] Two-leg chat (Hermes default + Cerebras scaffold) behind one `/api/chat`
- [x] Self-pruning UI-log mirror + Hermes server log
- [x] `start.bat` (STT/TTS/UI only; never touches Hermes)
- [x] buildREADME brought current + commit (revert point for the UI build)

**UI build (Phase 3):**
- [ ] 3A — HUD shell + VIEWS iframes (:9119) + Holo Panel summon channel + `hud_display` plugin
- [ ] 3B — graft our voice (armed mic, mic on/off, re-arm, barge-in, Pocket) onto the HUD
- [ ] 3C — side panels: `:9119` RPC stats + local psutil + token tally (placeholders first)

**Later:**
- [ ] Phase 4 — Cerebras direct-LLM live key + latency A/B (drop-in, no UI change)
- [ ] Final human-facing `README.md` (after UI build)

---

## 9. Verified load-bearing facts (do not re-derive)

- Chat = `/api/ws` JSON-RPC on `:9119`; NOT `/api/console`, NOT `:8642`.
- Token auto-discovered from `:9119` page (random per start; re-read every start / Hermes restart).
- `session.create` (profile=`lars`) + cache id; NOT `session.most_recent` (→4001). No `surface` param.
- `message.delta` text at `params.payload.text`; ends with `message.complete`.
- `lars-pocket-tts` and `lars15` are **READ-ONLY**; `lars13` (jarvis_ai) is copy-source only.
- `voice_url` on Pocket must be an `http(s)://` / `hf://` URL; bare names are ignored → built-in `alba`.
