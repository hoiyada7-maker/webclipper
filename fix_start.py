content = b"""@echo off
cd /d "%~dp0.."
if not exist ".venv\\Scripts\\python.exe" (
    echo [X] Virtual environment not found. Please run setup.bat
    pause
    exit /b 1
)

echo [>>] Cleaning up...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8000" ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F /T >nul 2>&1
)

echo [OK] Starting Web Clipper...
start /B cmd /c "ping 127.0.0.1 -n 3 >nul & start http://127.0.0.1:8000"

.venv\\Scripts\\python main.py
pause
"""

with open(r"C:\Users\su\pjt\webclipper-main\scripts\start.bat", "wb") as f:
    f.write(content.replace(b'\n', b'\r\n'))
