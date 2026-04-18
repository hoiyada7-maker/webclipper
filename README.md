# ✂️ Web Clipper

> 웹 페이지 콘텐츠를 클립하여 이미지 포함 완전한 Markdown 파일로 저장하는 자동화 도구입니다.  
> Playwright 브라우저가 내장되어 로그인이 필요한 사이트의 이미지도 다운로드하며,  
> **FastAPI** 기반 웹 UI로 브라우저에서 모든 작업을 처리합니다.

---

## 🚀 빠른 시작

### Windows

```
# 최초 1회 — 환경 설치
scripts\setup.bat

# 이후 매번 — 서버 실행
scripts\start.bat
```

### Linux / macOS

```bash
# 최초 1회 — 환경 설치
bash scripts/setup.sh

# 이후 매번 — 서버 실행
./scripts/start.sh
```

> 설치 및 실행 후 브라우저에서 `http://127.0.0.1:8000` 접속

---

## ✨ 주요 기능

### 탭 1 · 웹클리퍼

| 기능 | 설명 |
|------|------|
| **클립보드 읽기** | 복사한 HTML을 불러와 소스 / 렌더링 미리보기 |
| **Tab 2 자동 스크롤** | SPA·무한스크롤 페이지를 1초 간격으로 자동 스크롤해 전체 콘텐츠 로드 |
| **HTML 생성** | 클립보드 내용 기반 `.html` 파일 저장 |
| **MD(이미지링크) 생성** | 이미지를 `assets/` 폴더에 저장하고 로컬 경로로 연결된 `.md` 생성 |
| **MD(이미지포함) 생성** | 이미지를 Base64로 인라인 임베드한 독립 `.md` 생성 |

### 탭 2 · 이미지 포함 MD로 변환

이미지 링크 타입 `.md` 파일을 선택하면 이미지를 Base64로 임베드해 단일 파일로 변환합니다.

### 탭 3 · 이미지를 주소로 연결한 MD로 변환

Base64 이미지가 포함된 `.md` 파일을 선택하면 이미지를 `assets/` 폴더에 추출하고 로컬 경로 `.md`를 생성합니다.

### 탭 4 · 각각의 이미지에서 글자/이미지 추출하여 MD로 변환

MD 파일 내 이미지에서 영역을 지정해 OCR 텍스트 추출 또는 크롭 이미지로 변환합니다.

| 단계 | 설명 |
|------|------|
| **① 영역 선택** | 이미지를 오른쪽 작업 영역에 표시 — 마우스로 텍스트/그림 영역 지정 |
| **② OCR 미리보기** | Windows OCR(`ko-KR`)로 인식된 텍스트를 편집 가능한 미리보기로 표시 |
| **최종 변환** | 영역별 선택(글자/그림)에 따라 기존 MD의 이미지를 교체한 새 MD 생성 |

---

## 📁 프로젝트 구조

```
webclipper/
├── main.py                  # FastAPI 서버, Playwright 관리, 파이프라인 오케스트레이터
├── image_downloader.py      # 이미지 URL 추출 & 다운로드 (브라우저/requests 폴백)
├── html_replacer.py         # HTML 이미지 경로 치환
├── md_converter.py          # HTML → Markdown 변환 (WebClipperMarkdownConverter)
│
├── scripts/                 # 설치·실행 스크립트
│   ├── setup.sh / setup.bat # 최초 환경 설치
│   └── start.sh / start.bat # 서버 실행
│
├── templates/
│   └── index.html           # 웹 UI (4탭 구조, WebSocket 로그, 캔버스 영역 선택)
├── static/
│   └── style.css            # 다크 테마 UI 스타일
│
└── output/                  # 결과물 저장 폴더 (자동 생성)
    ├── YYYY-MM-DD HHMMSS 제목.html
    ├── YYYY-MM-DD HHMMSS 제목.md
    ├── YYYY-MM-DD HHMMSS 제목_embedded.md
    ├── YYYY-MM-DD HHMMSS 제목_OCR.md
    └── assets/              # 다운로드·크롭된 이미지
```

---

## 🌐 API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/` | 웹 UI |
| `POST` | `/api/process` | 웹클리퍼 전체 파이프라인 실행 |
| `GET` | `/api/output_files` | output/ 폴더 MD 파일 목록 |
| `GET` | `/api/download` | 결과 파일 다운로드 (`?path=파일명`) |
| `POST` | `/api/embed_images` | MD 이미지 Base64 인라인 임베드 |
| `POST` | `/api/extract_images` | MD Base64 이미지 → 파일 추출 |
| `POST` | `/api/scroll/start` | Tab 2 자동 스크롤 시작 |
| `GET` | `/api/md_images` | MD 파일 내 이미지 경로 목록 반환 |
| `GET` | `/api/image_raw` | 이미지 파일 원본 반환 |
| `POST` | `/api/preview_extract` | 영역 크롭 + OCR 미리보기 |
| `POST` | `/api/ocr_region` | 단일 영역 OCR 재실행 |
| `POST` | `/api/extract_text_manual` | 최종 MD 생성 (글자/그림 교체) |
| `WS` | `/ws/logs` | 실시간 처리 로그 스트리밍 |

---

## 📦 의존 패키지

| 패키지 | 용도 |
|--------|------|
| `fastapi` / `uvicorn` | 웹 서버 |
| `jinja2` | HTML 템플릿 |
| `websockets` | 실시간 로그 스트리밍 |
| `playwright` | 브라우저 자동화 (인증 이미지 다운로드, 자동 스크롤) |
| `beautifulsoup4` | HTML 파싱 |
| `requests` | HTTP 이미지 다운로드 |
| `Pillow` | 클립보드 이미지 캡처 폴백 |
| `markdownify` | HTML → Markdown 변환 |
| `winsdk` | Windows OCR API (`ko-KR` 한국어 인식) |
| `PyQt6` | 서버 측 클립보드 접근 |

---

## ⚠️ 주의 사항

| 항목 | 내용 |
|------|------|
| **OCR 언어팩** | Windows 설정 → 언어 → 한국어 OCR 팩 설치 필요 (`winsdk` 사용) |
| **`ImageGrab`** | Windows / macOS 전용 (Linux에서는 Playwright 다운로드로 대체) |
| **자동 스크롤** | Shadow DOM·SPA URL 변경 모두 대응, 최대 300회(5분) 제한 |
| **브라우저 프로필** | `.browser_profile/`에 로그인 상태 저장 — 삭제 시 재로그인 필요 |
| **포트** | 기본 `8000` — 변경 시 `main.py` 하단 `uvicorn.run(... port=XXXX)` 수정 |
