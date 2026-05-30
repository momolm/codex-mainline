@echo off
setlocal

cd /d "%~dp0"

echo Stopping Codex Mainline and watchdog...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Stop-CodexMainline.ps1" -StopWatchdog -DirectStop -InitialDelaySeconds 0 -StopWaitSeconds 5
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" (
  echo Stop-all request failed with exit code %EXITCODE%.
  echo Check runtime\tg_mainline\shutdown.jsonl and keepalive.jsonl for details.
  echo.
  echo Press any key to close this launcher window...
  pause >nul
  exit /b %EXITCODE%
)

echo Codex Mainline and watchdog were stopped.
echo It is safe to start again with Start-CodexMainline.bat.
echo.
echo Press any key to close this launcher window...
pause >nul
exit /b 0
