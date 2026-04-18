#!/bin/bash
# ──────────────────────────────────────────────────────────
#  Web Clipper — 서버 실행 스크립트 (Linux / macOS)
# ──────────────────────────────────────────────────────────
set -e

# 프로젝트 루트 (scripts/ 의 상위 디렉터리)
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 가상환경 확인
if [ ! -f ".venv/bin/python" ]; then
    echo "❌ 가상환경이 없습니다. 먼저 scripts/setup.sh 를 실행해주세요."
    exit 1
fi

echo "=================================================="
echo "  Web Clipper 시작"
echo "  접속 주소: http://127.0.0.1:8000"
echo "  종료: Ctrl+C"
echo "=================================================="

exec .venv/bin/python main.py
