@echo off
setlocal
cd /d %~dp0

:: ============================================================================
::  lars-pocket-app launcher
::  Starts ONLY this app's own pieces: Pocket TTS (voice out), the UI app (npm),
::  and opens the browser. STT runs in the BROWSER (Web Speech API) - no server.
::
::  Assumptions (we NEVER touch these):
::    * Hermes is running and :9119 is live (the app auto-connects to it).
::    * A browser with a mic is available.
::    * If Pocket TTS is already running on :1133 we just reuse it.
:: ============================================================================

:: ---- 1. App port from .env (fallback 1122) ----
set PORT=1122
if exist .env for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" set PORT=%%b
:: Trim stray spaces (e.g. "PORT = 1122" in .env) so :%PORT% stays a clean number.
set "PORT=%PORT: =%"

:: ---- 2. Pocket TTS (:1133) - start only if not already listening ----
echo [start] checking Pocket TTS on :1133 ...
netstat -ano | findstr /r /c:":1133 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [start] Pocket TTS already running on :1133 - reusing it
  goto tts_up
)
:: Race guard: uvx's FIRST run (download/extract) can take 30-60 s. A second launch
:: inside that window would die in its window with uvicorn's [Errno 10048] bind error
:: ("only one usage of each socket address"). So start it, then poll :1133 until it
:: actually binds (or warn and continue - the app health-checks TTS itself too).
echo [start] Pocket TTS not running - starting it in its own window...
start "Pocket TTS" cmd /k "uvx pocket-tts serve --port 1133"
echo [start]   waiting for Pocket TTS to bind :1133 (first run may take a while)...
set /a tts_wait=0
:tts_poll
timeout /t 2 /nobreak >nul
set /a tts_wait+=2
netstat -ano | findstr /r /c:":1133 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [start]   Pocket TTS is up on :1133
  goto tts_up
)
if %tts_wait% LSS 90 goto tts_poll
echo [start]   WARNING: Pocket TTS has not bound :1133 after 90 s - check the "Pocket TTS" window.
:tts_up

:: ---- 3. UI app (this server) on :PORT ----
:: Kill any stale server still listening on the app port so relicitations always
:: recycle the old process and run the current code (avoids the "old node serves
:: stale code" trap). Then start fresh.
echo [start] checking for a stale server on :%PORT%:
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  echo [start]   stopping stale server PID %%p on :%PORT%
  taskkill /F /PID %%p >nul 2>&1
  timeout /t 1 /nobreak >nul
)
echo [start] starting lars-pocket-app on http://localhost:%PORT%
start "" "http://localhost:%PORT%"
npm start

endlocal
