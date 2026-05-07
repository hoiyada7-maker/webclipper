@echo off
chcp 949 >nul
REM ============================================================
REM  Web Clipper - 초기 설치 스크립트 (Windows, 1회만 실행)
REM ============================================================

REM 프로젝트 루트 (scripts\ 의 상위 디렉토리)
cd /d "%~dp0\.."

echo ==================================================
echo   Web Clipper 설치를 시작합니다
echo ==================================================

REM -- 기존 프로세스 정리 --
echo [>>] 기존 실행 프로세스 정리 중...
for /f "tokens=5" %%a in ('netstat -ano 2^>/dev/null ^| findstr ":8000" ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F /T >/dev/null 2>&1
)
powershell -NoProfile -Command "Get-Process chrome -EA SilentlyContinue | Where-Object { $_.Path -like '*ms-playwright*' } | Stop-Process -Force -EA SilentlyContinue" >/dev/null 2>&1
if exist ".browser_profile\lockfile" (del ".browser_profile\lockfile" >nul 2>&1)
timeout /t 1 >/dev/null 2>&1
echo [OK] 정리 완료

REM -- 1. Python 확인 --
python --version >/dev/null 2>&1
if errorlevel 1 (
    echo [X] python 이 설치되어 있지 않습니다.
    echo     https://www.python.org/downloads/ 에서 설치 후 재시도하세요.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('python --version') do echo [OK] Python: %%v

REM -- 2. 가상환경 생성 --
if not exist ".venv\Scripts\python.exe" (
    echo.
    echo [>>] 가상환경 생성 중...
    python -m venv .venv
    echo [OK] 가상환경 생성 완료
) else (
    echo [OK] 가상환경 이미 존재
)

REM -- 3. Visual C++ Build Tools 확인 및 설치 (winsdk 빌드용) --
echo.
echo [>>] Visual C++ Build Tools 확인 중...
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "HAS_VCTOOLS="
if exist "%VSWHERE%" (
    for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set HAS_VCTOOLS=%%i
)
if defined HAS_VCTOOLS (
    echo [OK] Visual C++ Build Tools 이미 설치됨
) else (
    echo [>>] Visual C++ Build Tools 설치 중 (수분 소요)...
    winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo [X] Visual C++ Build Tools 설치 실패
        echo     https://visualstudio.microsoft.com/visual-cpp-build-tools/ 에서 수동 설치 후 재시도하세요.
        pause
        exit /b 1
    )
    echo [OK] Visual C++ Build Tools 설치 완료
)

REM -- 4. pip 업그레이드 ^& 패키지 설치 --
echo.
echo [>>] 패키지 설치 중...
.venv\Scripts\pip install --upgrade pip -q
.venv\Scripts\pip install -r requirements.txt -q
echo [OK] 패키지 설치 완료

REM -- 5. Playwright Chromium 설치 --
echo.
echo [>>] Playwright Chromium 설치 중...
set PLAYWRIGHT_BROWSERS_PATH=0
.venv\Scripts\python -m playwright install chromium
echo [OK] Playwright Chromium 설치 완료

REM -- 6. 필요 디렉토리 생성 --
echo.
echo [>>] 디렉토리 생성 중...
if not exist "output" mkdir output
if not exist "output\assets" mkdir output\assets
if not exist "static" mkdir static
echo [OK] 디렉토리 생성 완료

echo.
echo ==================================================
echo   설치 완료!
echo   실행: scripts\start.bat
echo ==================================================
pause
