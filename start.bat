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

:: ---- 2. Pocket TTS (:1133) - start only if not already listening ----
echo [start] checking Pocket TTS on :1133 ...
netstat -ano | findstr /r /c:":1133 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [start] Pocket TTS already running on :1133 - reusing it
) else (
  echo [start] Pocket TTS not running - starting it in its own window...
  start "Pocket TTS" cmd /k "uvx pocket-tts serve --port 1133"
)

:: ---- 3. UI app (this server) on :PORT ----
echo [start] starting lars-pocket-app on http://localhost:%PORT%
start "" "http://localhost:%PORT%"
npm start

endlocal
