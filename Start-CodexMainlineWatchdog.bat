@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js 20+ and try again.
  echo.
  echo Press any key to close this launcher window...
  pause >nul
  exit /b 1
)

if not exist "config\telegram.local.json" (
  echo Missing config\telegram.local.json.
  echo Copy examples\telegram.local.example.json to config\telegram.local.json, then fill bot_token and allowed_chat_id.
  echo.
  echo Press any key to close this launcher window...
  pause >nul
  exit /b 1
)

echo Starting Codex Mainline watchdog in the background...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-CodexMainlineWatchdog.ps1" -HiddenWatchdog -HiddenMainline
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" (
  echo The watchdog did not start. Exit code: %EXITCODE%.
  echo Check runtime\tg_mainline\watchdog.stderr.log for details.
  echo.
  echo Press any key to close this launcher window...
  pause >nul
  exit /b %EXITCODE%
)

echo Codex Mainline watchdog is running in the background.
echo This launcher window can be closed; closing it will not stop Codex Mainline.
echo To stop both mainline and watchdog, run Stop-CodexMainlineAndWatchdog.bat.
echo Logs: %~dp0runtime\tg_mainline
echo.
echo Press any key to close this launcher window...
pause >nul
exit /b 0
