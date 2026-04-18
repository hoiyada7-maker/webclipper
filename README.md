# ✂️ Web Clipper

> 웹 페이지 콘텐츠를 클립하여 이미지 포함 완전한 Markdown 파일로 저장하는 자동화 도구입니다.  
> Playwright 브라우저가 내장되어 로그인이 필요한 사이트의 이미지도 다운로드하며,  
> **FastAPI** 기반 웹 UI로 브라우저에서 모든 작업을 처리합니다.

---

## 🚀 빠른 시작

### Linux / macOS

```bash
# 최초 1회 — 환경 설치
bash scripts/setup.sh

# 이후 매번 — 서버 실행
./scripts/start.sh
```

### Windows

```
# 최초 1회 — 환경 설치
scripts\setup.bat

# 이후 매번 — 서버 실행
scripts\start.bat
```

> 설치 및 실행 후 브라우저에서 `http://127.0.0.1:8000` 접속

---

## ✨ 주요 기능

| 기능 | 설명 |
|------|------|
| **클립보드 읽기** | 복사한 Clipboard 내용을 불러와서 미리보기 (HTML소스 / 렌더링) |
| **Tab2 자동 스크롤 시작** | 화면에 이동해야 해당 부분만 렌더링 되는 웹페이지에 대응하여, 전체페이지를 불러오기 위해 1초 간격 자동 스크롤 → Shadow DOM·SPA 무한스크롤 대응 |
| **HTML생성** | 클립보드 내용을 바탕으로 html 파일 생성 |
| **MD(이미지링크)생성** | 클립보드 내용을 바탕으로 이미지파일을 별도의 파일로 생성하고, 이를 링크하여 MD파일에 표시하는 MD 파일 생성 |
| **MD(이미지포함)생성** | 클립보드 내용을 바탕으로 이미지가 MD파일에 포함된 MD 파일 생성 |
| **이미지포함MD로변환** | 이미지링크 타입MD파일을 이미지포함 타입MD파일로 변환 |
| **이미지링크MD로변환** | 이미지포함 타입MD파일을 이미지링크 타입MD파일로 변환 |

---

## 📁 프로젝트 구조

```
project/
├── main.py                  # FastAPI 서버, Playwright 관리, 파이프라인 오케스트레이터
├── image_downloader.py      # 이미지 URL 추출 & 다운로드 (브라우저/requests 폴백)
├── html_replacer.py         # HTML 이미지 경로 치환
├── md_converter.py          # HTML → Markdown 변환 (커스텀 컨버터)
│
├── scripts/                 # 설치·실행 스크립트
│   ├── setup.sh             # 최초 설치 (Linux / macOS)
│   ├── start.sh             # 서버 실행 (Linux / macOS)
│   ├── setup.bat            # 최초 설치 (Windows)
│   └── start.bat            # 서버 실행 (Windows)
│
├── templates/
│   └── index.html           # 웹 UI (탭 구조, WebSocket 로그, 드래그앤드롭)
├── static/
│   └── style.css            # 다크 테마 UI 스타일
│
├── output/                  # 결과물 저장 폴더 (자동 생성)
│   ├── YYYY-MM-DD HHMMSS 제목.html
│   ├── YYYY-MM-DD HHMMSS 제목.md
│   ├── YYYY-MM-DD HHMMSS 제목_embedded.md
│   └── assets/              # 다운로드된 이미지 (파일명: 실행ID_원본명.ext)
│
└── .browser_profile/        # Playwright 퍼시스턴트 프로필 (로그인 상태 유지)
```

---

## 🌐 API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/` | 웹 UI |
| `GET` | `/api/clipboard` | 서버 측 클립보드 읽기 |
| `POST` | `/api/process` | 전체 파이프라인 실행 |
| `GET` | `/api/download` | 결과 파일 다운로드 (`?path=파일명`) |
| `POST` | `/api/embed_images` | MD 이미지 Base64 인라인 임베드 |
| `POST` | `/api/scroll/start` | Tab 2 자동 스크롤 시작 |
| `GET` | `/api/user_page/html` | Tab 2 현재 페이지 HTML 반환 |
| `POST` | `/api/user_page/navigate` | Tab 2 URL 이동 |
| `WS` | `/ws/logs` | 실시간 처리 로그 스트리밍 |

---

## 📦 의존 패키지

| 패키지 | 용도 |
|--------|------|
| `fastapi` / `uvicorn` | 웹 서버 |
| `jinja2` | HTML 템플릿 |
| `websockets` | 실시간 로그 |
| `playwright` | 브라우저 자동화 (인증 이미지 다운로드, 자동 스크롤) |
| `beautifulsoup4` | HTML 파싱 |
| `requests` | HTTP 이미지 다운로드 |
| `Pillow` | 클립보드 이미지 캡처 폴백 |
| `markdownify` | HTML → Markdown |

---

## ⚠️ 주의 사항

| 항목 | 내용 |
|------|------|
| `ImageGrab` | Windows / macOS 전용 (Linux에서는 Playwright 다운로드로 대체) |
| 자동 스크롤 감지 | Shadow DOM·SPA URL 변경 모두 대응, 최대 300회(5분) 제한 |
| 브라우저 프로필 | `.browser_profile/`에 로그인 상태 저장 — 삭제 시 재로그인 필요 |
| 포트 | 기본 `8000` — 변경 시 `main.py` 하단 `uvicorn.run(... port=XXXX)` 수정 |
