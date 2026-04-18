@echo off
chcp 949 >nul
REM ============================================================
REM  Web Clipper - 서버 실행 스크립트 (Windows)
REM ============================================================

REM 프로젝트 루트 (scripts\ 의 상위 디렉토리)
cd /d "%~dp0\.."
set PLAYWRIGHT_BROWSERS_PATH=0

REM 가상환경 확인
if not exist ".venv\Scripts\python.exe" (
    echo [X] 가상환경이 없습니다. 먼저 scripts\setup.bat 을 실행하세요.
    pause
    exit /b 1
)

REM -- 기존 프로세스 정리 --
echo [>>] 기존 실행 프로세스 정리 중...
for /f "tokens=5" %%a in ('netstat -ano 2^>/dev/null ^| findstr ":8000" ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F /T >/dev/null 2>&1
)
powershell -NoProfile -Command "Get-Process chrome -EA SilentlyContinue | Where-Object { $_.Path -like '*ms-playwright*' } | Stop-Process -Force -EA SilentlyContinue" >/dev/null 2>&1
if exist ".browser_profile\lockfile" del /f ".browser_profile\lockfile" >/dev/null 2>&1
timeout /t 1 >/dev/null 2>&1
echo [OK] 정리 완료

echo ==================================================
echo   Web Clipper 실행
echo   접속 주소: http://127.0.0.1:8000
echo   종료: Ctrl+C
echo ==================================================

.venv\Scripts\python main.py
