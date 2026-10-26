@echo off
setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs

echo ============================================
echo Changan Monitor - manual run
echo Project: %CD%
echo Output is shown in this window.
echo Do not close this window while it is running.
echo ============================================
echo.

call pnpm run monitor
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo ============================================
echo Finished. Exit code: %EXIT_CODE%
echo ============================================
echo.
pause
exit /b %EXIT_CODE%
