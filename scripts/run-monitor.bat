@echo off
setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [%date% %time%] pnpm not found in PATH >> logs\monitor.log
  exit /b 1
)

call pnpm run monitor >> logs\monitor.log 2>&1
exit /b %ERRORLEVEL%
