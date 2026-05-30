@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js 20+ and try again.
  echo.
  pause
  exit /b 1
)

if not exist "config\telegram.local.json" (
  echo Missing config\telegram.local.json.
  echo Copy examples\telegram.local.example.json to config\telegram.local.json, then fill bot_token and allowed_chat_id.
  echo.
  pause
  exit /b 1
)

echo Starting Codex Mainline watchdog...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-CodexMainlineWatchdog.ps1" -HiddenWatchdog -HiddenMainline
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" (
  echo Watchdog start failed with exit code %EXITCODE%.
  echo Check runtime\tg_mainline\watchdog.stderr.log for details.
  echo.
  pause
  exit /b %EXITCODE%
)

echo Codex Mainline watchdog was started in the background.
echo Logs: %~dp0runtime\tg_mainline
echo.
pause
exit /b 0
