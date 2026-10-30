# HowToDebug — lars-pocket-app

Debug manual for a future AI (or human) on **this Windows machine** (`C:\lars-pocket-app`).
Written from real outages. The goal: from any symptom, get to the failing component in minutes.

---

## 0. TL;DR — run these first (in order)

```cmd
:: 1. Are the three load-bearing ports up?
netstat -ano | findstr /r /c:":9119 .*LISTENING" /c:":1122 .*LISTENING" /c:":1133 .*LISTENING"
::    WANT: 9119 (Hermes dashboard) + 1122 (this app) both listening, 1133 if TTS is used

:: 2. Is the Hermes dashboard page serving the token the app scrapes?
curl -s http://127.0.0.1:9119/ | findstr "__HERMES_SESSION_TOKEN"

:: 3. What does the app itself think?  (brain / profile / pocketUp / hermesUrl)
curl http://localhost:1122/api/config

:: 4. If chat "worked" but returned nothing, read the app's Hermes log tail:
tail -40 logs/server.log
::    "could not obtain a Hermes session"  ==  :9119 down (or token missing)
```

If `:9119` is down → go straight to **§9.1**. If Pocket TTS shows the `[Errno 10048]` bind
error → **§6.2**. If the browser says `STT error: network` → **§6.3**.

---

## 1. Data-flow order (memorize this)

```
Chrome / HUD (Web Speech STT — GOOGLE service, no server, no key)
  → transcript (2 s silence or 2nd click = send)
  → POST http://localhost:1122/api/chat   {messages:[...]}   (OpenAI-SSE shape)
  → server.js Hermes leg:
      GET  http://127.0.0.1:9119/                ← scrapes window.__HERMES_SESSION_TOKEN__
      WS   ws://127.0.0.1:9119/api/ws?token=…    ← persistent socket
      RPC  session.create {profile:lars}  → cache session_id
      RPC  prompt.submit {session_id, text}       ← the actual turn
  → Hermes streams back message.delta (text at params.payload.text)
  → server.js cleanSpokenText() strips tool narration/HTML/URLs
  → SSE data: {choices:[{delta:{content}}]} back to the browser
  → browser sentence-chunker → POST /api/tts {text}
  → Pocket TTS :1133 → chunked WAV → Web Audio gapless playback
```

**Order of failure-masking:** STT is browser-only → a broken mic/permission shows up as "STT
error: network" with NO server involvement. A dead `:9119` shows up as **"empty reply from
LLM"** *after* a successful transcript — the voice part worked, Hermes failed. Always read the
frontend panel / `logs/ui.log` and `logs/server.log` **together** to see where the chain broke.

---

## 2. Component map & how to identify processes

| Port | Component | Process signature (`wmic` command line) | Started by |
|---|---|---|---|
| 1122 | This app | `node --env-file=.env server.js` | `start.bat` / `npm start` |
| 1133 | Pocket TTS | `pocket-tts.exe serve --port 1133` (child of `uv.exe tool uvx …`) | `start.bat` (only if down) or `POCKET_CMD` in `server.js` |
| 9119 | **Hermes dashboard** (the one the app needs!) | `hermes … dashboard --port 9119 --host 127.0.0.1 --no-open` | Login VBS: `…\desktop-plugins\lars\specs\Hermes_Dashboard.vbs` |
| 60719 etc. | Hermes desktop backend | `…\hermes-agent\.hermes\bin\hermes.exe serve --host 127.0.0.1 --port 0` | Hermes desktop app (Hermes.exe) |
| 8642 | Hermes gateway API server | `python … -m hermes_cli.main gateway run` | `…\gateway-service\Hermes_Gateway.cmd` |

**NOT the same thing (the classic trap):**
- The **Hermes desktop app** (`Hermes.exe`, Electron) spawns its backend with `--port 0` →
  a **random port each boot** (e.g. 60719). Nothing anywhere should rely on that port.
- The **`:9119` dashboard is a separate process** and is what this app is wired to. It does
  **not** auto-come-back just because the desktop app restarted — it runs at *login* via
  `Hermes_Dashboard.vbs`, which sets `HERMES_DASHBOARD_SESSION_TOKEN=lars-voice-bridge-2026`.
- **`:8642`** (gateway API server) is Hermes-side and **not used by this app** — do not debug
  the app via 8642.

### PID workflow (Windows)
```cmd
netstat -ano | findstr :9119                       :: right column = PID
wmic process where "ProcessId=<PID>" get Name,CommandLine   :: what IS that process?
taskkill /F /PID <PID>                              :: kill it (dashboard + parent chain if needed)
```

---

## 3. Logs — where the truth lives

| Log | Path | What it captures | Clock |
|---|---|---|---|
| **Hermes turns** | `C:\lars-pocket-app\logs\server.log` | `hlog()` lines: `submit:`, `prompt.submit result:`, unknown event kinds, session errors | **UTC** (ISO, `Z` suffix) |
| **Browser panel mirror** | `C:\lars-pocket-app\logs\ui.log` | `POST /api/log` from the UI: STT start/errors, state changes, "sending: …", "empty reply from LLM" | **LOCAL** (add the UTC offset to correlate — this box is UTC+2) |
| **App boot** | `C:\lars-pocket-app\logs\node-out.log` / `node-err.log` | console.log at startup (`[hermes] ws open`, `[pocket-tts] already running…`) | local |
| Hermes desktop | `...\AppData\Local\hermes\logs\desktop.log` | backend spawn, `HERMES_BACKEND_READY port=…`, gateway restart attempts | UTC |
| Hermes gateway | `...\AppData\Local\hermes\logs\gateway.log` / `gateway-restart.log` / `gateway-exit-diag.log` | gateway lifecycle, multiplex warnings, unclean-exit diag | UTC |
| Hermes errors | `...\AppData\Local\hermes\logs\errors.log` | warnings — e.g. `event loop stalled` (GIL), session-scoped RPC rejected | local-ish |
| In-browser | HUD right-side log panel | same stream as `ui.log`, live | local |

**Reading a failure from the logs (real example, 2026-10-28):**
```
ui.log    [10:28:41] Silence 2000 ms → sending: "what time is it in Belarus"   ← STT worked
ui.log    [10:28:52] LLM done 10483 ms, 0 chars / Chat error: empty reply from LLM
server.log [2026-10-28T08:28:52Z] turn 1 error: could not obtain a Hermes session  ← root cause
```
10:28:41 local == 08:28:41 UTC → same event, two clocks. The chain broke at the **Hermes leg**,
not at STT — the blast radius of `:9119` being down.

**Known log lines and what they mean:**
- `turn N error: could not obtain a Hermes session` → `session.create` failed → `:9119` down or
  the WS never reached `gateway.ready`. **Fix `:9119`.**
- `[hermes] no token found on dashboard page` (console) → `GET :9119/` didn't contain
  `window.__HERMES_SESSION_TOKEN__` → dashboard up but token broken (env var missing on restart).
- `Pocket TTS unreachable after 25 tries: …` (ui.log) → TTS warm-up (first run downloads the
  model) or TTS died; check `:1133/health`.
- `Pocket TTS warm: first byte … ms` (ui.log) → TTS healthy; metric = latency.
- `GROQ_API_KEY is missing in .env` (ui.log, every boot) → **vestigial noise** from the old
  chassis (`public/app.js` checks a `keySet` field `/api/config` doesn't return). The brain is
  Hermes/Cerebras, not Groq. Ignore it.
- `event: session.reclaimed … reason: ws_orphan_reap` (server.log) → Hermes reaped an orphaned
  WS; the app's session may be stale → it already auto-recreates once (see `stale` retry block).
- `[pocket-tts] exited (N)` → the spawned TTS died; check `:1133`.

---

## 4. CLI command kit

```cmd
:: --- run components ---
start.bat                                     :: Pocket TTS (if down) + UI + browser
uvx pocket-tts serve --port 1133               :: Pocket TTS alone
npm start                                     :: this app alone (node --env-file=.env server.js)

:: --- sanity probes ---
curl http://127.0.0.1:1133/health             :: Pocket TTS: expect ok/200
curl http://localhost:1122/api/config         :: app: brain/profile/pocketUp/hermesUrl
curl -s http://127.0.0.1:9119/ | findstr "__HERMES_SESSION_TOKEN"
curl -s -o /dev/null -w "%{http_code}" -H "Connection: Upgrade" -H "Upgrade: websocket" ^
     "http://127.0.0.1:9119/api/ws?token=x"  :: 400 = WS route present; 404 = dashboard is wrong

:: --- end-to-end chat test (through the app, streams a real Lars reply) ---
curl -s -m 45 -X POST http://localhost:1122/api/chat -H "Content-Type: application/json" ^
     -d "{\"messages\":[{\"role\":\"user\",\"content\":\"say hi\"}]}"

:: --- process/port surgery ---
netstat -ano | findstr :9119
wmic process where "ProcessId=<PID>" get Name,CommandLine
taskkill /F /PID <PID>

:: --- syntax sanity before edits ---
node --check server.js public/app.js public/state.js
```

---

## 5. How each piece actually starts (and what you must NOT assume)

1. **Hermes desktop app** (Hermes.exe) — user starts it. Spawns backend on **random port** (`--port 0`).
   Do NOT assume it serves `:9119`.
2. **`:9119` dashboard** — login VBS `specs\Hermes_Dashboard.vbs` (hidden, detached):
   `HERMES_DASHBOARD_SESSION_TOKEN=lars-voice-bridge-2026 hermes dashboard --port 9119 --host 127.0.0.1 --no-open`.
   On a "Hermes-only" restart it does **not** come back by itself — you must relaunch it (§9.1).
3. **Gateway** (`gateway run`) — `gateway-service\Hermes_Gateway.cmd` → api server on `:8642`,
   ticks profiles incl. `lars`. Per-profile "Gateway Status: Off" in the Hermes UI is **normal**
   (multiplex; one host gateway serves all profiles) — not a fault.
4. **Pocket TTS** — `start.bat` checks `:1133` with `netstat -ano | findstr /r /c:":1133 .*LISTENING"`
   then `start "Pocket TTS" cmd /k "uvx pocket-tts serve --port 1133"` if nothing is listening.
   **Race:** the check runs once; if TTS is still booting (uvx first-run can take 30–60 s) it is
   missed, and a second launch hits `[Errno 10048]` → §6.2.
5. **This app** — `npm start` → `node --env-file=.env server.js`. `server.js` ALSO tries to start
   Pocket TTS itself (`POCKET_CMD`) if the health probe fails; it **never** starts Hermes.

**Autostart reality (verified 2026-10-28) — there is NO working Hermes autostart on this box:**

- The only Startup-folder item is `Shell:Startup\Hermes_Dashboard.vbs.disabled` — the `:9119`
  dashboard login VBS, but **renamed `.disabled` so it does NOT run**. After any reboot/login,
  `:9119` is down until you run §9.1 manually. (Don't re-enable it by renaming back unless you're
  sure you won't also launch the dashboard by hand — two of them = the second can't bind :9119.)
- **No Scheduled Tasks and no HKCU/HKLM Run entries** for Hermes/dashboard/gateway (checked 2026-10-28).
- VBS files that DO exist (all manual):

  | VBS | Path | Purpose |
  |---|---|---|
  | `Hermes_Dashboard.vbs` | `...\hermes\desktop-plugins\lars\specs\` | Start `:9119` dashboard with token env (`lars-voice-bridge-2026`), hidden+detached — **the file this app depends on** (§9.1) |
  | `Hermes_Gateway.vbs` (+ `.cmd`) | `...\hermes\gateway-service\` | Detached `gateway run` → `:8642` API server + multiplex gateway (not used by this app, needs to run for Hermes messaging) |
  | `Hermes_Dashboard.vbs.disabled` | `Shell:Startup` | Same file as `specs\`, disabled |
  | `logs\Hermes_Dashboard.vbs.bak`, `logs\_launch_notoken.cmd` | this repo `logs\` (gitignored) | stale backup; launcher with a **typo'd path** (`hermein`) — do not use |

---

## 6. Known failure modes (real outbreaks, already solved)

### 6.1 `:9119` down → "empty reply from LLM" / "could not obtain a Hermes session"
- **Symptom:** voice transcript appears, then `Chat error: empty reply from LLM`; server.log shows
  `could not obtain a Hermes session` (or `no token found on dashboard page`).
- **Cause:** dashboard process not running (login VBS didn't re-fire; Hermes restart; other process
  grabbed 9119). The desktop app's backend on a random port does NOT substitute.
- **Fix:** relaunch the dashboard ($9.1). No app restart needed — the app re-discovers the token
  on the next chat (each `hermesRpc` re-fetches).

### 6.2 Pocket TTS `[Errno 10048]` bind on `('::1', 1133, …)` in a "Pocket TTS" window
- **Cause:** duplicate start — two `uvx pocket-tts serve --port 1133` raced; the loser prints the
  uvicorn bind error and sits in a `cmd /k` window. The `netstat` check in `start.bat` can't see a
  still-booting instance.
- **Verify:** `netstat -ano | findstr :1133` → exactly ONE `LISTENING` line is healthy; the leftover
  window is harmless (its python exited). Current instance = look for `pocket-tts.exe serve --port 1133`
  via `wmic`.
- **Fix:** close the stale window; optionally make `start.bat` wait/retry the port check.

### 6.3 Chrome/Web Speech `STT error: network` loop
- **Symptom:** ui.log repeats `STT session started` / `STT error: network` every ~1 s — the client
  restarts the recognizer immediately on failure (tight loop).
- **Cause:** the Web Speech API needs Google's speech service reachable from `localhost`; after a
  **Chrome update** (or network blip / mic-permission reset) the recognizer fails and the loop hammers it.
- **Check/fix:** confirm the HUD page is on `http://localhost` (secure context — `127.0.0.1` also OK);
  `chrome://settings/content/microphone` → allow; **restart Chrome** (kill via Task Manager, quit fully);
  if it persists, reload the page to break the loop. There is **no server-side STT** — do not add keys.
- **Watch-out:** don't `taskkill` all `chrome.exe` — the user has other tabs; target the HUD instance
  (or just use Chrome's own restart).
- **Local-STT fallback (if Chrome STT keeps failing):** this app has no local STT, but the engine
  already exists on this box in the separate voice stack `desktop-plugins\lars\voice\`
  (voice_server.py :8000): **sherpa-onnx 1.13.8** (streaming zipformer-20M, wake-word, silero VAD)
  in `voice\.venv` + `voice\models\`, and **faster-whisper 1.2.1** in the hermes-agent venv. To go
  local, reuse that engine — sherpa-onnx (1.13+) also runs the newer tiny/accurate **Moonshine**
  models (a model download only, no new runtime). Chrome's cloud Web Speech recognition has had
  intermittent regional outages since Jul-2026 (verified 2026-10-28).

### 6.4 "Waiting for Pocket TTS to load (first run downloads the model)…"
- First ever TTS run downloads the model (can be ~30–60 s). During this, `/api/tts` returns
  "Upstream not reachable" and ui.log may say `Pocket TTS unreachable after 25 tries`.
- Not a bug — subsequent boots are fast. Keep `:1133/health` as the definitive check.

### 6.5 Session stale (`4001` / `ws_orphan_reap` / compaction rotation)
- `server.js` already handles it: on a `4001`/`not found` prompt.submit error it nulls the cached
  session_id, recreates, and retries the turn once. If you see the log line `session stale … ->
  recreating session, retrying once`, that's the safety net working — not a crash.

### 6.6 Lars "doesn't know" `hud_display` (no Holo Panels)
- **The plugin is hand-copied, NOT live-linked.** `hermes-plugin/hud_display/` (repo) is the
  *source*; Hermes runs its own separate copy at `profiles\lars\plugins\hud_display\`. No symlink,
  no auto-sync — editing the repo folder changes nothing over there. Update recipe: **re-copy the
  folder (overwrite) → restart the `:9119` dashboard → new Lars session.** (2026-10-28: both copies
  verified byte-identical via `diff -rq` — that's from the hand-copy, not a link.)
- The `:9119` dashboard caches its plugin/tool registry **at startup**. After any plugin/config/SOUL
  edit you must **restart the dashboard process** AND start a **new** Lars session — restarting the
  desktop app alone serves stale tools.
- Plugin must live in the **`lars` profile home** (`...\hermes\profiles\lars\plugins\hud_display\`)
  and be listed in `profiles\lars\config.yaml` → `plugins.enabled` — the *global* scope is ignored
  by Lars's session.

### 6.7 Hermes gateway exits / restarts "periodically"
- `gateway-exit-diag.log` records `previous_unclean_exit` entries — often from an agent/admin
  `taskkill` killing the interpreter image, not a real crash. If pid is running and gateway.log says
  `Gateway running with N platform(s)`, it's fine.

### 6.9 v0.22.5 tool-call JSON spoken + shown in chat — FIXED 2026-10-30
- **Symptom:** tool calls appeared in the chat bubble AND were spoken aloud (e.g.
  `Just a moment…{"tool":"hud_display",…}}`).
- **Cause:** v0.22.5 streams tool-call JSON INLINE in `message.delta` text, chunked (`segment`/`offset`);
  the old per-chunk regex couldn't match a partial JSON (no closing brace in the chunk), so fragments leaked.
- **Fix (server.js):** `cleanSpokenStream()` — a stateful, brace-balanced buffer that drops complete
  `{"tool"…}`/`{"name"…}` blocks across chunk boundaries, retracts interim narration glued before them
  ("Just a moment…", "Okay, checking that…"), and flushes at turn end. Verified against real DB text
  (`profiles\lars\state.db` messages table) 2026-10-30.
- **If it recurs:** check `profiles\lars\state.db` → `messages` for inline JSON in assistant content, and
  re-test with the chunked repro (narration + `{` split across deltas).

### 6.8 Hermes v0.22.5 session ownership — Desktop/Dashboard refuse to open the app's session
- **Symptom:** app chat works, but in Hermes Desktop the session shows stored turns with a persistent
  `Resume failed: JsonRpcGatewayError: runtime_coordination_required` banner; the `:9119` dashboard
  web UI errors the same way.
- **Mechanism:** v0.22.5 enforces ONE live owner per session via a per-profile lease registry
  (`<HERMES_HOME>\profiles\<profile>\runtime\active_sessions.json`). The claim is PID-scoped and held
  by whichever process runs the turns — here the `:9119` dashboard. Any second opener (Desktop's own
  backend, or another client of the same dashboard) is refused `runtime_coordination_required`;
  single-writer exclusivity is deliberate (historical double-writer/interrupt bugs). Release happens
  on session end / WS drop / process exit (`ws_orphan_reap`, `idle_timeout`, …).
- **The transcript reader is NOT gated:** Desktop pages stored rows over REST — clicking **away and
  back** refreshes the view. That is the sanctioned (if manual) way to watch our session live-ish.
  Ignore the banner — it is cosmetic for this workflow.
- **Do NOT chase as an app bug** — verified root cause 2026-10-28 (lease held by PID 11948 for
  session 20261028_121948_83c64e). Workarounds: (1) HUD chat panel = live view; (2) Desktop
  click-away/back refresh; (3) view-after: once the runtime releases (app stopped / dashboard
  restarted / session ended), any surface mounts the full history read-only.
- **Upstream pressure (ours):** nousresearch/hermes-agent#146014 (filed 2026-10-28) + open request
  #28690 for observe/coordination. Downgrading to v0.21.5 restores pre-update attach behavior if
  this ever matters more than the update's fixes.

---

## 7. Windows shell traps for the agent (Git Bash vs cmd vs PowerShell)

The agent's `terminal` tool here runs **Git Bash** (regardless of Zed defaults):

- **NEVER put a bare `$` in an inline command** — Git Bash expands `$VAR` to empty before the
  command runs → broken args and confusing `ParserError`s. For PowerShell needing vars/`$_`,
  write a temp `.ps1` (e.g. under `.zed/` — gitignored), run `powershell -File it.ps1`, delete it.
- **`/c:` flags get mangled** by Git Bash into paths. Run cmd-only bits through
  `cmd //c "…"` (double slash), or from inside `start.bat` context only.
- **Prefer Git-Bash-safe tools:** `netstat`, `tasklist`, `wmic`, `curl`, `grep`, `findstr` via
  cmd — over PowerShell-only cmdlets (`Test-Path` doesn't exist in bash).
- `wmic process where "ProcessId=N" get Name,CommandLine` is the reliable way to see what a PID
  actually is (beats guessing from `tasklist`).
- Windows `findstr /r /c:":9119 .*LISTENING"` (real cmd) works — verified 2026-10-28.
- Timestamps: `server.log` is **UTC**; `ui.log`/`node-*.log` are **local (UTC+2)**. Correlate by
  subtracting/adding the offset before blaming the wrong component.

---

## 8. Watch-outs & invariants (do not "fix")

- `:9119` = the app's only Hermes door. `session.create` (profile set by `HERMES_PROFILE`), cache the
  id, NO `surface` param (4000), don't trust `session.most_recent` (4001).
- `message.delta` text lives at `params.payload.text`; turn ends on `message.complete`. Speak-stream =
  only what survives `cleanSpokenText()` (tool narration, `<HUD …>` tags, URLs, JSON are stripped).
- Token is **per dashboard start** unless `HERMES_DASHBOARD_SESSION_TOKEN` is set — that's why the
  VBS sets it. Re-read the page after any dashboard restart (the app does this automatically).
- `app.js`/`state.js` are loaded verbatim by BOTH `/` and `/hud/` — one voice engine.
- The single listening gate is `canListen() = armed && !micMuted && !stopped && !testMode`;
  Space is bound **exactly once** (app.js) — never rebind Space inside the HUD's inline scripts.
- **One persistent Lars session — the app's own Hermes session.** `server.js` does `session.create`
  (profile = `HERMES_PROFILE`) and caches the `session_id` across turns: every voice/typed turn is ONE
  continuous real Hermes session, so the **full chat log is visible in Hermes desktop/dashboard →
  Sessions** (and can be continued there). While the app holds it, using that session elsewhere lets
  Hermes reclaim it (`ws_orphan_reap` / 4001) — the app auto-creates a fresh session (§6.5).
- External pages must go through `/api/embed` strip-proxy to iframe; YouTube keeps `/embed/`.
- READ-ONLY reference repos: `C:\Users\Admin\lars-pocket-tts`, `C:\Users\Admin\lars13`.
  Never edit or push them.
- `.env` is gitignored; `.zed/`, `logs/`, `models/`, `bin/` are gitignored — `git status` dirt is
  always source files only (the `.defender-*.ps1` scratch scripts were removed 2026-10-28).
- READ ME before changing `start.bat`: its Pocket TTS launch now polls `:1133` for up to 90 s after
  starting (mitigates the §6.2 10048 double-start), but two rapid manual `start.bat` runs during a
  slow first boot can still double-launch TTS — don't re-simplify the check back to a single netstat.

---

## 9. Restart-the-world cheat sheet

### 9.1 Bring back the `:9119` Hermes dashboard (the most common fix)
```cmd
:: hidden + detached, token env baked in (the login mechanism):
wscript "C:\Users\Admin\AppData\Local\hermes\desktop-plugins\lars\specs\Hermes_Dashboard.vbs"

:: or manually in a console:
set HERMES_DASHBOARD_SESSION_TOKEN=lars-voice-bridge-2026
"C:\Users\Admin\AppData\Local\hermes\bin\hermes.cmd" dashboard --port 9119 --host 127.0.0.1 --no-open

:: verify:
netstat -ano | findstr :9119
curl -s http://127.0.0.1:9119/ | findstr "__HERMES_SESSION_TOKEN"
```

### 9.2 Full app stack restart
```cmd
:: kill stale app + TTS, then relaunch clean:
for /f "tokens=5" %p in ('netstat -ano ^| findstr /r /c:":1122 .*LISTENING"') do taskkill /F /PID %p
for /f "tokens=5" %p in ('netstat -ano ^| findstr /r /c:":1133 .*LISTENING"') do taskkill /F /PID %p
start.bat
```

### 9.3 Hermes side (only when Hermes itself is broken)
- Desktop app: relaunch `Hermes.exe` (`...\hermes-agent\apps\desktop\release\win-unpacked\Hermes.exe`).
- Gateway: run `...\gateway-service\Hermes_Gateway.cmd` (api server :8642, multiplex gateway).
- Dashboard must be relaunched **after** any of the above (it does not come back on its own) — §9.1.
- After plugin/config edits: restart dashboard + start a **new** Lars session (§6.6).
