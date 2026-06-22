<p align="center">
  <img src="./src-tauri/icons/128x128.png" width="128" alt="MD Toolbox" />
</p>

<h1 align="center">MD Toolbox</h1>

<p align="center"><em>마크다운 파일을 다루는 데스크톱 툴킷 — 웹 클리퍼 확장프로그램 포함.</em></p>

<p align="center">
  <a href="./README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/hoiyada7-maker/webclipper/releases/latest"><img src="https://img.shields.io/github/v/release/hoiyada7-maker/webclipper?style=flat-square&color=black&label=release" alt="release" /></a>
  <img src="https://img.shields.io/badge/Windows-10%2B-black?style=flat-square" alt="windows" />
  <img src="https://img.shields.io/badge/macOS-13%2B-black?style=flat-square" alt="macos" />
  <img src="https://img.shields.io/badge/Linux-x86__64-black?style=flat-square" alt="linux" />
  <img src="https://img.shields.io/badge/Chrome-extension-black?style=flat-square" alt="chrome" />
  <img src="https://img.shields.io/badge/license-MIT-black?style=flat-square" alt="mit" />
</p>

이 리포지터리는 두 가지 도구를 포함합니다:

- **MD Toolbox** — Tauri 2 기반 크로스플랫폼 데스크톱 앱. 마크다운 파일 안의 이미지를 base64로 삽입하거나 파일로 추출하고, OCR로 이미지 영역을 텍스트로 변환합니다.
- **Web Clipper** — Chrome 확장프로그램. 웹 페이지를 자급자족 마크다운 파일로 클립합니다. 네이버 블로그·카페 특별 지원.

## 기능

### MD Toolbox (데스크톱 앱)

| 탭 | 하는 일 |
|----|---------|
| **Embed** | `.md` 파일 안의 로컬 이미지 경로를 base64 data URI로 인라인 치환 — 외부 파일 없이 단일 파일로 |
| **Extract** | base64 / 로컬 이미지 링크를 `assets/` 폴더로 추출하고 경로를 재작성 |
| **OCR Studio** | `.md` 안의 이미지를 선택해 영역을 드래그하면 Windows OCR 텍스트 또는 크롭 그림으로 변환 → `_OCR_<타임스탬프>.md` 출력 *(Windows 전용)* |

### Web Clipper (Chrome 확장)

| 기능 | 설명 |
|------|------|
| 페이지 클립 | 현재 탭을 이미지 포함 마크다운으로 변환 |
| 키보드 단축키 | `Ctrl+Shift+U` · Mac은 `⌘⇧U` — 팝업 없이 즉시 클립 |
| 네이버 지원 | 네이버 블로그·카페의 iframe 구조 + 지연 로딩 이미지(`?type=w773`) 처리 |
| 팝업 | 클립 미리보기, 설정 변경, 출력 폴더 열기 |

## 설치

### MD Toolbox

[최신 릴리스 다운로드 →](https://github.com/hoiyada7-maker/webclipper/releases/latest)

**Windows (x64)** — `*_x64-setup.exe` 또는 `*_x64_en-US.msi` 다운로드 후 실행.

**macOS Apple Silicon** — `MD.Toolbox.dmg` 다운로드 → `/Applications`에 드래그 → 실행.

**macOS Intel** — `MD.Toolbox_intel.dmg` 다운로드 → 동일하게 설치.

**Linux (x86_64)** — 배포판에 맞게 선택:
- **AppImage** (어디서나 실행): `chmod +x *.AppImage` 후 실행
- **.deb** (Debian / Ubuntu): `sudo dpkg -i *.deb`
- **.rpm** (Fedora / RHEL): `sudo dnf install *.rpm`

> OCR Studio는 Windows OCR 엔진을 사용하며 Windows 10+ 전용입니다.

### Web Clipper (Chrome)

Chrome 웹 스토어 등록 전 — 압축 해제 상태로 로드:

1. 이 리포지터리를 클론 또는 다운로드
2. Chrome에서 `chrome://extensions` 열기
3. **개발자 모드** 활성화 (우측 상단 토글)
4. **압축 해제된 확장 프로그램 로드** 클릭 → `extension/` 폴더 선택

## 소스 빌드

[bun](https://bun.sh), [rust](https://rustup.rs), 그리고 플랫폼별 [Tauri 사전 요구사항](https://tauri.app/start/prerequisites/)이 필요합니다. Linux는 `libwebkit2gtk-4.1-dev libsoup-3.0-dev` 등 Tauri 의존성도 설치하세요.

```sh
bun install
bun run tauri dev      # HMR이 포함된 개발 창 실행
bun run tauri build    # src-tauri/target/release/bundle/ 아래 설치 파일 생성
```

## 기술 스택

| 레이어 | 선택 |
|--------|------|
| 데스크톱 셸 | tauri 2 (rust + webview) · Windows · macOS · Linux |
| 프런트엔드 | react 19 · vite 7 · typescript 5 · bun |
| 이미지 처리 | rust `image` · `imageproc` |
| OCR | Windows OCR 엔진 (`windows-rs`) — ko-KR + en-US |
| 확장프로그램 | Chrome MV3 · vanilla JS |

## 개인정보

로컬 우선. 텔레메트리·계정·클라우드 동기화 없음. 파일은 디스크에만 저장되며, 직접 복사하기 전에는 아무것도 외부로 전송되지 않습니다.

## 라이선스

MIT · [hoiyada7-maker](https://github.com/hoiyada7-maker)
