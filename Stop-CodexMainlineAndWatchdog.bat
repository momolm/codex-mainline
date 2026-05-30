@echo off
setlocal

cd /d "%~dp0"

echo Stopping Codex Mainline and watchdog...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Stop-CodexMainline.ps1" -StopWatchdog -InitialDelaySeconds 0 -StopWaitSeconds 5
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" (
  echo Stop-all request failed with exit code %EXITCODE%.
  echo Check runtime\tg_mainline\shutdown.jsonl and keepalive.jsonl for details.
  echo.
  pause
  exit /b %EXITCODE%
)

echo Stop-all request was queued. The watchdog will stop the mainline and then exit.
echo.
pause
exit /b 0
