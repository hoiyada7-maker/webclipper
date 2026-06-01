<p align="center">
  <h1 align="center">✂️ Web Clipper</h1>
</p>

<p align="center"><em>웹 페이지를 완전한 Markdown 파일로 클립합니다.</em></p>

<p align="center">
  <a href="https://github.com/hoiyada7-maker/webclipper/releases/latest"><img src="https://img.shields.io/github/v/release/hoiyada7-maker/webclipper?style=flat-square&color=blue&label=release" alt="release" /></a>
  <a href="https://github.com/hoiyada7-maker/webclipper/releases"><img src="https://img.shields.io/github/downloads/hoiyada7-maker/webclipper/total?style=flat-square&color=black&label=downloads" alt="downloads" /></a>
  <img src="https://img.shields.io/badge/Windows-10%2B-black?style=flat-square" alt="windows" />
  <img src="https://img.shields.io/badge/Linux-x86__64-black?style=flat-square" alt="linux" />
  <img src="https://img.shields.io/badge/python-3.11%2B-black?style=flat-square" alt="python" />
  <img src="https://img.shields.io/badge/license-MIT-black?style=flat-square" alt="license" />
</p>

<p align="center">
  <a href="README.md">English</a>
</p>

로그인이 필요한 페이지나 무한스크롤 페이지를 포함해 모든 웹 페이지를 이미지 포함 Markdown 파일로 저장하는 브라우저 통합 웹 클리핑 도구입니다.

## 주요 기능

| 영역 | 내용 |
|---|---|
| **클리핑** | 클립보드 HTML 읽기, 내장 Playwright 브라우저로 무한스크롤 자동 스크롤 |
| **이미지** | 브라우저 쿠키를 활용해 인증 이미지 다운로드, 클립보드 캡처 폴백 |
| **출력 형식** | HTML · 이미지 링크 MD · Base64 임베드 MD (단일 이식 가능 파일) |
| **변환** | 링크 방식 ↔ 임베드 방식 MD 언제든 상호 변환 |
| **OCR** | 이미지 영역 지정 후 텍스트 추출 (Windows OCR, `ko-KR` / `en-US`) 또는 크롭 |
| **실시간 로그** | WebSocket으로 파이프라인 각 단계를 실시간 스트리밍 |

## 설치

[최신 릴리즈 다운로드 →](https://github.com/hoiyada7-maker/webclipper/releases/latest)

### Windows (10 이상, x64)

1. `webclipper-vX.X.X-windows-x64.zip` 다운로드
2. 압축 해제 → `webclipper.exe` 실행
3. **첫 실행 시** Chromium 브라우저 자동 다운로드 (약 150MB, 인터넷 필요)
4. 브라우저에서 UI가 자동으로 열림

### Linux (x86_64)

**AppImage** (모든 배포판):
```sh
chmod +x webclipper-vX.X.X-linux-x86_64.AppImage
./webclipper-vX.X.X-linux-x86_64.AppImage
```

**deb** (Debian / Ubuntu / Mint):
```sh
sudo dpkg -i webclipper_vX.X.X_amd64.deb
webclipper
```

### 소스에서 실행

Python 3.11 이상 필요.

```sh
# Windows
scripts\setup.bat
scripts\start.bat

# Linux / macOS
bash scripts/setup.sh
./scripts/start.sh
```

실행 후 `http://127.0.0.1:8000` 접속.

또는 `make` 사용:

```sh
make setup   # 최초 1회: .venv 생성 및 패키지 설치
make start   # 서버 실행
```

## 동작 원리

```
클립보드 HTML
  → image_downloader.py   브라우저 컨텍스트로 이미지 다운로드 (쿠키 보존)
  → html_replacer.py      <img src>를 로컬 ./assets/ 경로로 치환
  → md_converter.py       수정된 HTML → Markdown 변환
  → output/               .html · .md · _embedded.md
```

## 기술 스택

| 레이어 | 선택 |
|---|---|
| 서버 | FastAPI + uvicorn |
| 브라우저 | Playwright (퍼시스턴트 컨텍스트, 스텔스 패치) |
| HTML 파싱 | BeautifulSoup4 + markdownify |
| 클립보드 | PyQt6 (서버 측 클립보드 읽기) |
| OCR | winsdk Windows OCR API (`ko-KR`, `en-US`) |
| 이미지 처리 | opencv-python + Pillow + numpy |
| 패키징 | PyInstaller → `.exe` / `.AppImage` / `.deb` |

## 주의 사항

| | |
|---|---|
| **OCR 언어팩** | Windows 설정 → 언어 → 한국어 OCR 팩 설치 필요 |
| **ImageGrab** | 클립보드 이미지 캡처 폴백은 Windows / macOS 전용 |
| **브라우저 프로필** | 로그인 상태가 `.browser_profile/`에 저장됨 — 삭제 시 재로그인 필요 |
| **포트** | 기본 `8000` — 변경 시 `main.py` 하단 `uvicorn.run(..., port=XXXX)` 수정 |
| **첫 실행** | Chromium 자동 다운로드 (약 150MB), 이후 실행부터는 즉시 시작 |
