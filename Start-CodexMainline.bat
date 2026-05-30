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

call "%~dp0Start-CodexMainlineWatchdog.bat"
exit /b %ERRORLEVEL%
