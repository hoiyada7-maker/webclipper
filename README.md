<p align="center">
  <h1 align="center">✂️ Web Clipper</h1>
</p>

<p align="center"><em>clip web pages into self-contained markdown files.</em></p>

<p align="center">
  <a href="https://github.com/hoiyada7-maker/webclipper/releases/latest"><img src="https://img.shields.io/github/v/release/hoiyada7-maker/webclipper?style=flat-square&color=blue&label=release" alt="release" /></a>
  <a href="https://github.com/hoiyada7-maker/webclipper/releases"><img src="https://img.shields.io/github/downloads/hoiyada7-maker/webclipper/total?style=flat-square&color=black&label=downloads" alt="downloads" /></a>
  <img src="https://img.shields.io/badge/Windows-10%2B-black?style=flat-square" alt="windows" />
  <img src="https://img.shields.io/badge/Linux-x86__64-black?style=flat-square" alt="linux" />
  <img src="https://img.shields.io/badge/python-3.11%2B-black?style=flat-square" alt="python" />
</p>

<p align="center">
  <a href="README.ko.md">한국어</a>
</p>

A browser-integrated web clipping tool that saves any page — including auth-gated and infinite-scroll pages — as portable Markdown files with images bundled in.

## what you get

| area | details |
|---|---|
| **clipping** | read HTML from clipboard, auto-scroll infinite pages via built-in Playwright browser |
| **images** | download images using browser cookies (handles auth-protected assets), fallback to clipboard capture |
| **output formats** | HTML · MD with local image links · MD with Base64-embedded images (single portable file) |
| **conversion** | convert between link-style and embed-style MD at any time |
| **OCR** | select regions on images to extract text (Windows OCR, `ko-KR` / `en-US`) or crop as image |
| **real-time logs** | WebSocket log stream shows every pipeline step as it runs |

## install

[download the latest release →](https://github.com/hoiyada7-maker/webclipper/releases/latest)

### Windows (10+, x64)

1. Download `webclipper-vX.X.X-windows-x64.zip`
2. Extract the zip → run `webclipper.exe`
3. On first launch, Chromium downloads automatically (~150 MB, internet required)
4. The UI opens in the browser automatically

### Linux (x86_64)

**AppImage** (works anywhere):
```sh
chmod +x webclipper-vX.X.X-linux-x86_64.AppImage
./webclipper-vX.X.X-linux-x86_64.AppImage
```

**deb** (Debian / Ubuntu / Mint):
```sh
sudo dpkg -i webclipper_vX.X.X_amd64.deb
webclipper
```

### from source

requires Python 3.11+.

```sh
# Windows
scripts\setup.bat
scripts\start.bat

# Linux / macOS
bash scripts/setup.sh
./scripts/start.sh
```

Then open `http://127.0.0.1:8000` in your browser.

## how it works

```
Clipboard HTML
  → image_downloader.py   download images via browser context (preserves cookies)
  → html_replacer.py      rewrite <img src> to local ./assets/ paths
  → md_converter.py       convert patched HTML → Markdown
  → output/               .html · .md · _embedded.md
```

## stack

| layer | choice |
|---|---|
| server | FastAPI + uvicorn |
| browser | Playwright (persistent context, stealth patches) |
| html parsing | BeautifulSoup4 + markdownify |
| clipboard | PyQt6 (server-side clipboard read) |
| OCR | winsdk Windows OCR API (`ko-KR`, `en-US`) |
| image processing | opencv-python + Pillow + numpy |
| packaging | PyInstaller → `.exe` / `.AppImage` / `.deb` |

## notes

| | |
|---|---|
| **OCR language pack** | Windows Settings → Language → install Korean OCR pack |
| **ImageGrab** | clipboard image fallback is Windows / macOS only |
| **browser profile** | login state is saved in `.browser_profile/` — delete to reset |
| **port** | default `8000` — change in `main.py` → `uvicorn.run(..., port=XXXX)` |
| **first launch** | Chromium auto-downloads on first run (~150 MB); subsequent launches start instantly |
