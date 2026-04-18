#!/bin/bash
# ──────────────────────────────────────────────────────────
#  Web Clipper — 최초 설치 스크립트 (Linux / macOS, 1회만 실행)
# ──────────────────────────────────────────────────────────
set -e

# 프로젝트 루트 (scripts/ 의 상위 디렉터리)
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=================================================="
echo "  Web Clipper 설치를 시작합니다"
echo "=================================================="

# ── 1. Python 확인 ──
if ! command -v python3 &>/dev/null; then
    echo "❌ python3 가 설치되어 있지 않습니다."
    echo "   sudo apt install python3 python3-venv python3-pip"
    exit 1
fi
PYTHON_VER=$(python3 --version)
echo "✅ Python: $PYTHON_VER"

# ── 2. 가상환경 생성 ──
if [ ! -d ".venv" ]; then
    echo ""
    echo "▶ 가상환경 생성 중..."
    python3 -m venv .venv
    echo "✅ 가상환경 생성 완료"
else
    echo "✅ 가상환경 이미 존재"
fi

# ── 3. pip 업그레이드 & 패키지 설치 ──
echo ""
echo "▶ 패키지 설치 중..."
.venv/bin/pip install --upgrade pip -q
.venv/bin/pip install -r requirements.txt -q
echo "✅ 패키지 설치 완료"

# ── 4. Playwright Chromium 설치 ──
echo ""
echo "▶ Playwright Chromium 설치 중..."
PLAYWRIGHT_BROWSERS_PATH=0 .venv/bin/playwright install chromium
echo "✅ Playwright Chromium 설치 완료"

# ── 5. 필요 디렉터리 생성 및 권한 설정 ──
echo ""
echo "▶ 디렉터리 설정 중..."
mkdir -p output/assets
chmod -R 755 output
mkdir -p static
chmod 755 static
echo "✅ 디렉터리 설정 완료"

# ── 6. start.sh 실행 권한 부여 ──
chmod +x scripts/start.sh

echo ""
echo "=================================================="
echo "  설치 완료!"
echo "  실행: ./scripts/start.sh"
echo "=================================================="
