@echo off
setlocal
set "ROOT=%~dp0"
pwsh -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\Start-CodexCompanionInbox.ps1"
if errorlevel 1 pause
endlocal
