# BUILDREADME — lars-pocket-app

Authoritative build doc for **lars-pocket-app** (local `C:\lars-pocket-app`, GitHub
`AxiomLC/lars-pocket-app`, branch `main`). Covers the HUD build (Phase 3) and the
baseline it stands on. A separate human-facing `README.md` comes after the UI build.

> ## ⭐ FALLBACK — the last-known-good plain voice UI (pre-HUD)
> If the HUD work ever breaks or you just want the simple voice page back, this is the
> exact, fully-working **two-way voice → Lars** beta that predates the HUD:
>
> - **Commit `6fe468c`** on `main` — `public/index.html` (old pocket-tts voice UI) +
>   `public/app.js` + `public/state.js`. Voice round-trip, barge-in, re-arm, typed chat,
>   Pocket `alba` all verified working end-to-end.
> - **To revert the HUD** (bring back the plain voice UI as `/`):
>   `git checkout 6fe468c -- server.js public/index.html public/app.js public/state.js public/style.css .env.example start.bat`
>   then `npm start` → `http://localhost:1122/` gives the old working voice page.
> - **`app.js` + `state.js` are still loaded by the HUD** (`/hud/` pulls them in
>   verbatim), so the voice engine behind the new UI is byte-identical to this beta.
> - The old voice page (`public/index.html`) is still served at `/` and remains usable
>   alongside the HUD — it was not deleted.

---

## 1. What this app is (current state: HUD UI + working voice)

A single-node (no-dependency `node:http`) web app on **`http://localhost:1122`** that delivers
**two-way voice chat to a live Hermes `lars` profile session**, served through TWO UIs:

- **`/hud/`** — the jarvis-style **HUD** (Phase 3): full-screen interface with Holo Panels,
  VIEWS (kanban / dashboard / chat iframed from `:9119`), and the grafted voice engine. This is
  now the primary UI.
- **`/`** — the original pocket-tts voice page (pre-HUD beta), still served and working.

- **STT** — in-browser (Web Speech API). No server.
- **Brain** — Hermes via the **`:9119` JSON-RPC/WebSocket gateway** (`/api/ws`), default `BRAIN=hermes`.
- **TTS** — Pocket TTS on `:1133` (uvx), served through our `/api/tts` proxy. Built-in `alba` voice.
- **Voice UX** — the four-control **priority chain**: **STOP → MASTER MIC → STREAMING →
  VOICE CHAT**, with the Orb/Space as push-to-talk, barge-in, sentence-chunked streaming
  playback and a typing box. Same `state.js` + `app.js` engine; full function map + flows in
  **§6C**.

```
Chrome (Web Speech STT; ring = push-to-talk; barge-in when STREAMING on)
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
| `C:\lars-pocket-app` | **THIS project.** Voice→Lars chat + jarvis-style HUD (Phase 3) on top. HUD at `/hud/`, old voice page at `/`. | **Active** |
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

## 4. Current state — the pre-HUD baseline this build stands on

This is the STABLE baseline (old pocket-tts voice UI at `/`) that the HUD grafted its voice
engine from. Verified as of the beta `6fe468c`:

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
3. **HUD (primary):** open `http://localhost:1122/hud/` — click **VOICE CHAT**, then the ring /
   Space to talk; **STREAMING** on = barge in over Lars. Typed chat box feeds the same brain.
4. **Old voice page (fallback):** open `http://localhost:1122/` (unchanged baseline).

---

## 5. Naming glossary (locked — use exactly these)

| Term | Meaning | File / code |
|---|---|---|
| **HUD** | The whole full-screen UI laid on top of the voice chassis | `public/hud/index.html` |
| **Holo Panel** | A floating iframe pop-up the HUD shows on demand (any content: kanban, dashboard, chat, a web page) | `summonPanel()` / `#holoStage`, `.holo` |
| **Holo Panel M / F** | Medium / Full size variants of a Holo Panel | `position`/size in `summonPanel` |
| **VIEWS dock** | The fixed quick-jump buttons (KANBAN / DASHBOARD / CHAT) in the left column | `openView()` / `#viewer` |
| **summon channel** | The outgoing SSE pipe (`/events`) the server uses to *push* a Holo Panel to open HUDs | `server.js` SSE `/events` + `POST /api/summon` |
| **`/api/summon`** | Endpoint Lars (via tool) hits to trigger a Holo Panel | `server.js` |
| **`hud` toolset / `hud_display`** | Hermes-side tools Lars calls to summon/dismiss | `hermes-plugin/hud_display/` (deployed to `lars` profile home) |
| **VIEWS content** | Kanban / dashboard / chat iframed from `:9119` | iframes |

---

## 6. HUD UI build (Phase 3) — what it entails

Source: `C:\Users\Admin\lars13\server\hud\index.html` (single 885-line static file) +
`hermes-plugin/hud_display`. We **port the UI**, we do **not** port jarvis_ai's voice/audio stack.

### Sub-phase 3A — shell + VIEWS working (no voice wiring) ✅ DONE
1. Copy `hud/index.html` → `public/hud/index.html`, served by our `node:http` server (plain http,
   **not** Express — the project has zero dependencies by design).
   - Removed the PIN auth gate (we're loopback + our app owns auth).
   - HUD is a separate page at `/hud/`, independent of the current voice page.
2. **VIEWS = iframes pointed at `:9119`** — `openView('KANBAN','/kanban')`, DASHBOARD `/`,
   CHAT `/chat`. **VERIFIED live 2026-10: `:9119` sends NO `X-Frame-Options` and NO CSP
   `frame-ancestors`** on `/`, `/kanban`, `/chat` (all return the same React SPA `index.html`).
   So we iframe `:9119` directly — **no header-strip proxy needed** (simpler than the original plan).
3. **Holo Panel summon channel — DONE via SSE (zero deps):** `GET /events` (SSE stream each open
   HUD connects to via `EventSource`) + `POST /api/summon` broadcast. Our `server.js` fans a
   `summon_panel` / `dismiss_panels` SSE event out to all connected HUDs, which call the existing
   `summonPanel` / `dismissAllPanels`.  (`/api/pub`+`/api/events` on `:9119` were **not** reused —
   a local channel keeps the summon feed on our server, aligned with the voice channel that 3B adds.)
4. **`hud_display` plugin — brought into repo:** copied to `hermes-plugin/hud_display/` and adapted:
   `tools.py` now uses `LARS_SUMMON_URL` (default `http://127.0.0.1:1122/api/summon`) + `X-Lars-Token`;
   `schemas.py` points Lars at `http://127.0.0.1:9119/kanban` & `/`.
   **DEPLOYED** into the **`lars` profile scope** (`profiles\lars\plugins\hud_display\`) and enabled in
   `profiles\lars\config.yaml` → `plugins.enabled`, **not** the global scope — see §6A. No
   `hermes tools enable hud` is needed (plugin toolsets auto-enable; `hud` is not default-off).

### Sub-phase 3B — voice grafted onto the HUD ✅ DONE (controls now = the priority chain, §6C)
5. **Done:** the voice state machine (STT, barge-in, sentence-chunked playback, Pocket TTS) lives
   in `/hud/` — **`state.js` + `app.js` loaded directly** (not re-ported), so the engine is the
   same file-in-file as the legacy page. `app.js` binds `#mic`/`#rearm`/`#micSw`/`#stop`/`#echo`/
   `#send`/`#txt` and posts `.m` bubbles into `#chat` on the HUD.
6. **Controls:** the VOICE LINK panel holds the chain buttons (VOICE CHAT / STREAMING + the MIC
   gate row), **STOP** sits in the chat row next to SEND, and the Orb/Space is push-to-talk only
   (`orbPress()`). The reactor follows `State` (resting ring label = **L.A.R.S**). Full function
   map + flows = **§6C**. HUD inline scripts are IIFEs (their `$` must not collide with `app.js`'s
   `$` — that was the old "Identifier already declared" error); only `openView` + `setState` are
   exposed as globals.

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

## 6A. Hermes `lars` profile setup — REQUIRED for Lars to summon Holo Panels

> ⚠️ **Lars runs from its OWN profile home, NOT the global Hermes home.** On this machine that is
> `C:\Users\Admin\AppData\Local\hermes\profiles\lars\` — it has its own `config.yaml`, `SOUL.md`
> and `plugins/`. **Profile settings override global Hermes settings.** Any change meant to reach
> Lars must land in the **profile** scope, not `...\hermes\` (the global scope is ignored by Lars's
> session). Do not re-derive this — it was confirmed empirically and against the Hermes source
> (`plugins_discovery.collect_directory_manifests` scans `get_hermes_home()/plugins`, which under a
> multiplexed profile resolves to the profile home).

For someone configuring a fresh machine from this repo, to give their `lars` profile the Holo-Panel
`hud` toolset:

1. **Copy the plugin into the lars profile home** (NOT the global `...\hermes\plugins\`):
   ```cmd
   xcopy /E /I "C:\lars-pocket-app\hermes-plugin\hud_display" "C:\Users\Admin\AppData\Local\hermes\profiles\lars\plugins\hud_display"
   ```
2. **Enable it in the lars profile's `config.yaml`** — add to `plugins.enabled` (plugins are **opt-in**;
   `gate_manifest` skips anything not listed):
   ```yaml
   plugins:
     enabled:
       # - lars
       - strike-freedom-cockpit
       - hud_display
   ```
3. **Restart `hermes serve`** so `discover_plugins()` runs at startup and `register(ctx)` populates
   the `hud` toolset (`hud_display`, `hud_dismiss`).
4. **The `hud` toolset auto-enables** — plugin toolsets are NOT default-off (`_DEFAULT_OFF_TOOLSETS`
   only lists `homeassistant, spotify, discord, discord_admin, video, video_gen, x_search, a2a, kanban`),
   so **no `hermes tools enable hud` is needed** and no `platform_toolsets.cli` edit. It stays available
   to Lars even though his `agent.disabled_toolsets` disables `skills`/`file`/`terminal`/etc. for speed.

**Where the app's `/api/summon` gets its calls from:**
- `hermes-plugin/hud_display/tools.py` POSTs to `LARS_SUMMON_URL` (default `http://127.0.0.1:1122/api/summon`,
  override via env `LARS_SUMMON_URL`), with `X-Lars-Token` (env `LARS_HUD_TOKEN`).
- `server.js` `POST /api/summon` broadcasts `summon_panel` / `dismiss_panels` over the `/events` SSE
  feed to every open HUD tab at `/hud/`.
- `public/hud/index.html` renders the Holo Panel (`summonPanel()` handles `media=iframe|video|image`).

**Soul:** the `lars` profile persona lives at `...\profiles\lars\SOUL.md` (not the global `SOUL.md`).
It tells Lars to use `hud_display` (media: iframe for pages/dashboard, video for YouTube, image) and
`hud_dismiss`, keep replies short (streaming voice), and emit interim lines for >4s work. No runtime
Skill is needed — the `hud` **plugin toolset** is the mechanism (see §10 gotcha #3).

### Two "Gateway" things + multiplex — and the dashboard-restart rule

- **`:9119` is served by the `hermes dashboard` process** — this is the inbound web/RPC server our app
  connects to (`/api/ws`). **It must be running for the app to work.**
- **Per-profile "Gateway Status: Off" is normal.** With **multiplexing ON**, there is exactly ONE host
  gateway that serves every profile (`lars`, `hermes-desktop-coder`, ...). Profiles *do not* run their
  own gateway (the gateway-restart log says so verbatim: "Exactly one gateway per host... the profile
  does not get a gateway of its own"). "Off" per-profile = correct multiplex design, not a fault.
- **`8642` is the optional OpenAI API server (OFF, not needed by our app).** Port warnings about it in
  old gateway logs are noise.
- **Restart rule:** the `:9119` `hermes dashboard` process caches its plugin/tool registry at startup.
  After ANY major edit (enabling a plugin, changing config, editing SOUL) you must **restart the
  `hermes dashboard` process** (not just the desktop Electron app) and start a **new** Lars session —
  otherwise the running process serves stale tools (e.g. Lars "doesn't know" the `hud_display` tool).
  Restart: kill the dashboard PID then `hermes dashboard`.

---

## 6B. HUD fixes — external page/video rendering + spoken-thought filtering

Two integration fixes made during live testing (Beta v1.5):

### 1. External web pages / non-YouTube video won't frame (kanban ✓, pages ✗)

`summonPanel` iframes arbitrary URLs directly, but external sites send
`X-Frame-Options`/CSP `frame-ancestors` and refuse framing. The kanban works only
because `:9119` doesn't frame-block.

**Fix — `GET /api/embed?url=<encoded>` proxy in `server.js`:** fetches the target
server-side and re-serves it **without** `X-Frame-Options`/CSP `frame-ancestors`, so
it can be iframed (mirrors jarvis_ai's original `:9443` proxy, which we didn't port
at first). The HUD's `summonPanel` now routes **non-YouTube** content through
`/api/embed`; **YouTube keeps its native `/embed/` form** (`embedURL()`), which is
already frame-able. Any URL not matching `youtube|youtu.be` goes through the proxy.

> Caveat: a few sites break inside iframes via JS checks, and heavy JS/SPA or
> login-gated pages won't fully render (same limitation as the original repo).

### 2. Lars's tool-call "thoughts" were being spoken aloud

Lars's interim narration (`"ok, checking on that..."`), tool JSON, `<HUD DISPLAY>`
tags, and URLs all streamed as `message.delta` `payload.text` and were read out by
TTS (because `turn.push()` forwarded every delta verbatim).

**Fix — `cleanSpokenText()` in `server.js`:** `turn.push()` now passes each delta
through a filter that strips `<HUD ...>`/HTML tags, tool-call JSON, tool names
(`hud_display`, `web_search`, …), URLs, and markdown — only real deliverable prose
reaches the SSE/TTS stream. A `sawRaw` counter ensures a turn that produced only
filtered narration still completes on `message.complete` (no SSE hang).

---

## 6C. VOICE SYSTEM reference — priority chain, function map & flows

Design intent, function names and call flow of the voice leg. Written so an AI setting this
repo up for a new environment (fork) can trace any behavior from here without reading all
of `app.js` first.

### The chain (top wins) + state flags

| Rank | Control (button) | `state.js` flag | Meaning |
|---|---|---|---|
| 1 | **STOP** `#stop` | `stopped` | Top dog. Engaged: in-flight LLM + typed chat killed, VOICE CHAT/STREAMING forced off, ring dead, STOP glows red. Press again to release (no auto-resume of voice) |
| 2 | **MIC: ON/OFF** `#micSw` | `micMuted` | Hard cut of the mic circuit: `Microphone` chip, input-level bar and **MIC TEST** all go dead when OFF; hardware stream stopped. MIC ON is the only way back |
| 3 | **STREAMING** `#rearm` | `rearm` | Needs VOICE CHAT on. Mic live immediately and through Lars's reply → barge-in. Glow = state (no ON/OFF text; hover title carries the state) |
| 4 | **VOICE CHAT** `#mic` | `armed` | Turnabout: ring/Space = push-to-talk. OFF cuts listening only — never the running reply or typed chat |
| — | **MIC TEST** `#echo` | `testMode` | Hardware tone + 1.6 s RMS peak → verdict chip; suppressed by `micMuted` |

Rules enforced in `syncVoiceButtons()`: voice OFF ⇒ streaming OFF; streaming can't exist
without voice; STOP presides over both. Load defaults: `stopped=false, micMuted=false,
armed=false, rearm=false` (user must click VOICE CHAT = first Google-STT gesture).

Machine states (state.js `ALLOWED` map): `idle → listening → thinking → speaking` + any → idle.

### The single listening gate

```js
canListen() = armed && !micMuted && !stopped && !testMode     // app.js
```
Every path that opens/reopens the recognizer goes through it: `startListening()` entry,
its Chrome auto-restart in `rec.onend`, the post-reply re-arm (`speaker.onDone`), and the
`sendToLLM` error path. Don't sprinkle ad-hoc `State.armed` checks — extend the gate.

### Function map — engine (`public/app.js`)

| Function | Role |
|---|---|
| `syncVoiceButtons()` | Single renderer for all 4 buttons' glow/label/title; enforces the voice⇒streaming cascade. Call after ANY flag change |
| `orbPress()` | Orb + Space (bound ONCE in app.js): visual + push-to-talk. Dead if stopped/micMuted/!armed or streaming; `listening` → `commitUtterance()`; `idle` → push-talk session + `startListening()` |
| `startListening()` / `stopListening(keepArmed)` | Recognizer open / close. Outer gates pass `keepArmed=true` so voice-chat state survives mic cuts, streaming-off and MIC TEST |
| `commitUtterance()` | 2 s silence timeout or 2nd ring click → `sendToLLM`; resets `run.pushTalk` |
| `sendToLLM()` hooks | `speaker.onFirstAudio`: streaming ⇒ re-arm for barge; `speaker.onDone`: streaming⇒`listening` else `idle` (rest, ring prompt); error path mirrors `onDone` |
| `refreshMicStatus()` / `meterSync()` | VOICE LINK `Microphone` chip + input-level bar — both hard-gated by `micMuted` |
| `setEchoStatus(msg, ok)` | MIC TEST verdict chip (displays `MIC OFF` while the gate is cut) |
| `sendTyped()` | typing box → `sendToLLM`; refused while `stopped` |
| `echoVerdict()` / `cleanSpokenText()` | barge-in echo filter; strips tool-call narration from spoken deltas |
| `state.js` `State` | flags + machine; subscribers via `State.onChange` |

### Function map — HUD (`public/hud/index.html`, inline IIFE scripts)

- `voiceHint(st)` → ring hint text (`CHAT SESSION STOPPED` / `VOICE CHAT OFF` /
  `CLICK RING TO SPEAK` / `LISTENING — CLICK RING TO SEND` / `I'M LISTENING…`) — centered;
  MIC-off gets NO special label (the red MIC button is the indicator).
- `applyVoiceUI` = `State.onChange` subscriber → reactor `setState()` style + hint + refreshes.
- `#reactorWrap.onclick` → global `orbPress()`. **Do not bind Space here** — it lives in app.js.
- `bareify()` / `openView()` / `summonPanel()` — VIEWS + Holo machinery (unchanged, §6/§6B).

### Flow A — turnabout (STREAMING off)
`idle` → ring/Space click (`pushTalk=true`, `startListening`) → `listening` (2 s silence auto-
sends) → ring click again = send now → `commitUtterance` → `thinking` → first audio →
`speaking` (mic CLOSED, no barge) → `onDone` → `idle` (`CLICK RING TO SPEAK`). Toggling
VOICE CHAT off at any step never touches the in-flight reply.

### Flow B — streaming (STREAMING on)
Toggle ⇒ `startListening()` immediately; mic stays live across thinking→speaking; speech
during playback passes `echoVerdict()` then barge-in (`cancelEverything('barge-in')` →
`listening`). `onDone` re-arms: ring reads `I'M LISTENING…`.

### Flow C — MIC gate (cuts the whole circuit)
OFF: `stopListening(true)` + buf cleared + hardware tracks stopped + chip `MIC OFF` + bar
forced to rest + MIC TEST refused (chip `MIC OFF`). Glows/flags of voice/streaming untouched.
ON: STREAMING mode reopens the mic at once; turnabout waits for the ring.

### Flow D — STOP (top dog)
Press 1: `stopped=true`, stop listening, `cancelEverything` (history kept), streaming off,
SEND blocked, STOP red. Press 2: `stopped=false` → typed chat live immediately; VOICE CHAT
and STREAMING must each be switched back on manually.

### Fork-setup notes for an installer (new environment)
- **Env** (`.env` is gitignored; ship `.env.example`): `PORT`, `BRAIN`, `HERMES_PROFILE`,
  `POCKET_URL`/`POCKET_VOICE`, `HERMES_WS_ORIGIN` (fallback override), Cerebras trio
  (`CEREBRAS_API_KEY/MODEL/URL`) for the second leg.
- **Hermes preconditions:** `:9119` dashboard/serve up (token auto-discovered — §3),
  `hud_display` plugin in the PROFILE home + enabled (§6A), `TAVILY_API_KEY` for web search.
- **Voice preconditions:** `uvx pocket-tts serve --port 1133`; Chrome-class browser (Web Speech
  API + `rec.start(processedTrack)` echo cancellation).
- **Don't touch:** `lars-pocket-tts` / `lars13` (read-only references); Space binding (app.js);
  change button sizes via `.btn.sm` / `.btn.tgl` / `.btn.tgl.xs` in the HUD `<style>`.
- **Validate before shipping:** `node --check` on `server.js` + `public/app.js` + `state.js` and
  on each extracted inline `<script>` of `public/hud/index.html`, then eyeball the 4 controls,
  ring push-to-talk, barge-in and the MIC circuit (§6C Flows A–D).

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
- [x] 3A — HUD shell served at `/hud/`; VIEWS iframes point at `:9119` (no frame-block — verified); SSE summon channel (`/events` + `/api/summon`) + `hud_display` plugin brought in & adapted
- [x] 3A deploy — `hud_display` plugin **deployed into the `lars` profile scope** (`profiles\lars\plugins\hud_display\`) + enabled in `profiles\lars\config.yaml` `plugins.enabled`; `hud` toolset auto-enables (no `hermes tools enable` needed). Profile-setup steps documented in §6A.
- [x] 3B — **voice grafted onto the HUD** (`/hud/` loads `state.js` + `app.js` directly): STT, barge-in, Pocket playback live; controls later rewritten as the priority chain (§6C); resting ring label = **L.A.R.S**
- [x] 3B test — voice round-trip + barge-in confirmed live in `/hud/`
- [x] 3B-HUD fixes (Beta v1.5) — external pages/videos render via `/api/embed` proxy; Lars's tool-call thoughts no longer spoken (see §6B)
- [ ] 3C — side panels: `:9119` RPC stats + local psutil + token tally (placeholders first)

**Voice controls v2 — priority chain (§6C) — built, pending eyeball test:**
- [x] Chain rewrite: STOP > MASTER MIC > STREAMING > VOICE CHAT; Orb/Space = push-to-talk only
- [x] MIC gate wired through the Microphone chip, input-level bar and MIC TEST circuit (§6C Flow C)
- [x] Panel trims: `Tokens today` / `Turns today` rows + their `server.js` tally; DIAGNOSTICS `Refreshed` row
- [x] Cosmetics: plain `STREAMING` label (glow = state, dynamic hover title), matched button
      fonts/sizes, ring hints shortened + centered
- [ ] User eyeball test → then verify & commit

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
- **Plugin toolset `hud` auto-enables** — plugin toolsets are not in `_DEFAULT_OFF_TOOLSETS`, so once the
  `hud_display` plugin is enabled + Hermes restarted, Lars gets `hud_display`/`hud_dismiss` regardless of
  his `agent.disabled_toolsets` (which only disables `skills`/`file`/`terminal`/`code_execution`/etc. for
  streaming speed). No `hermes tools enable hud` required.
- **The `lars` profile is its own Hermes home** — `profiles\lars\` (config.yaml, SOUL.md, plugins/). Profile
  settings override global Hermes. Deploy plugin/config changes there, not the global scope.
- **External pages must be proxied to iframe** — raw iframes are blocked by `X-Frame-Options`/CSP. Use
  `/api/embed?url=` strip-proxy (HUD routes non-YouTube content through it; YouTube keeps `/embed/`).
- **Filter spoken deltas** — Lars's tool narration/JSON/HTML in `message.delta` `payload.text` is not meant
  to be heard; `cleanSpokenText()` strips it before TTS. A `sawRaw` counter prevents an all-filtered turn
  from hanging on `message.complete`.
- **One listening gate** — `canListen()` in `app.js` decides every recognizer open/restart; the voice
  chain's golden rule. Space is bound **exactly once** (app.js); the HUD ring calls the global
  `orbPress()` — never rebind Space inside the HUD scripts (double-fire = instant accidental sends).
