@echo off
cd /d "%~dp0\.."
set PLAYWRIGHT_BROWSERS_PATH=0

if not exist ".venv\Scripts\python.exe" (
    echo [X] .venv not found. Run scripts\setup.bat first.
    pause
    exit /b 1
)

echo [>>] Stopping existing server...
if exist server.pid (
    set /p SVPID=<server.pid
    taskkill /PID %SVPID% /F /T >nul 2>&1
    del server.pid >nul 2>&1
    timeout /t 1 >nul 2>&1
)

if exist ".browser_profile\lockfile" del /f ".browser_profile\lockfile" >nul 2>&1

echo [OK] Starting Web Clipper at http://127.0.0.1:8000
echo      Press Ctrl+C to stop.
echo ==================================================

.venv\Scripts\python main.py
