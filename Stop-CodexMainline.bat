@echo off
setlocal

cd /d "%~dp0"

call "%~dp0Stop-CodexMainlineAndWatchdog.bat"
exit /b %ERRORLEVEL%
