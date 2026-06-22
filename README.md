<p align="center">
  <img src="./src-tauri/icons/128x128.png" width="128" alt="MD Toolbox" />
</p>

<h1 align="center">MD Toolbox</h1>

<p align="center"><em>a desktop toolkit for markdown files — with a web clipper extension.</em></p>

<p align="center">
  <a href="./README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="https://github.com/hoiyada7-maker/webclipper/releases/latest"><img src="https://img.shields.io/github/v/release/hoiyada7-maker/webclipper?style=flat-square&color=black&label=release" alt="release" /></a>
  <img src="https://img.shields.io/badge/Windows-10%2B-black?style=flat-square" alt="windows" />
  <img src="https://img.shields.io/badge/macOS-13%2B-black?style=flat-square" alt="macos" />
  <img src="https://img.shields.io/badge/Linux-x86__64-black?style=flat-square" alt="linux" />
  <img src="https://img.shields.io/badge/Chrome-extension-black?style=flat-square" alt="chrome" />
  <img src="https://img.shields.io/badge/license-MIT-black?style=flat-square" alt="mit" />
</p>

two tools in one repo:

- **MD Toolbox** — a cross-platform desktop app (Tauri 2) that processes markdown files: embed images as base64, extract them back to files, and run OCR on image regions to turn screenshots into editable text.
- **Web Clipper** — a Chrome extension that clips any webpage to a self-contained markdown file, with special handling for Naver Blog and Cafe.

## what you get

### MD Toolbox (desktop)

| tab | what it does |
|-----|-------------|
| **Embed** | replaces local image paths in a `.md` file with inline base64 data URIs — one portable file, no external assets |
| **Extract** | pulls base64 / local image links back out to `assets/` files and rewrites the paths |
| **OCR Studio** | pick any image in a `.md` file, draw a region (or select the whole image), get Windows OCR text or a cropped figure — outputs a new `_OCR_<timestamp>.md` *(Windows only)* |

### Web Clipper (extension)

| feature | detail |
|---------|--------|
| clip any page | converts the active tab to markdown with images downloaded locally |
| keyboard shortcut | `Ctrl+Shift+U` · `⌘⇧U` on Mac — clips immediately without opening the popup |
| Naver support | handles Naver Blog and Cafe iframe structure + lazy-loaded images (`?type=w773`) |
| popup | preview the clip, adjust settings, open output folder |

## install

### MD Toolbox

[download the latest release →](https://github.com/hoiyada7-maker/webclipper/releases/latest)

**Windows (x64)** — grab `*_x64-setup.exe` or `*_x64_en-US.msi` → run.

**macOS Apple Silicon** — grab `MD.Toolbox.dmg` → drag into `/Applications` → open.

**macOS Intel** — grab `MD.Toolbox_intel.dmg` → same steps.

**Linux (x86_64)** — pick one:
- **AppImage** (runs anywhere): `chmod +x *.AppImage` → run
- **.deb** (Debian / Ubuntu): `sudo dpkg -i *.deb`
- **.rpm** (Fedora / RHEL): `sudo dnf install *.rpm`

> OCR Studio requires the Windows OCR engine and is only available on Windows 10+.

### Web Clipper (Chrome)

not on the Chrome Web Store yet — load as an unpacked extension:

1. clone or download this repo
2. open `chrome://extensions`
3. enable **Developer mode** (top-right toggle)
4. click **Load unpacked** → select the `extension/` folder

## from source

requires [bun](https://bun.sh), [rust](https://rustup.rs), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform. on Linux, also install `libwebkit2gtk-4.1-dev libsoup-3.0-dev` and related Tauri deps.

```sh
bun install
bun run tauri dev      # dev window with HMR
bun run tauri build    # produces installers under src-tauri/target/release/bundle/
```

## stack

| layer | choice |
|-------|--------|
| desktop shell | tauri 2 (rust + webview) · Windows · macOS · Linux |
| frontend | react 19 · vite 7 · typescript 5 · bun |
| image processing | rust `image` · `imageproc` |
| ocr | windows ocr engine (`windows-rs`) — ko-KR + en-US |
| extension | chrome mv3 · vanilla js |

## privacy

local-first. no telemetry, no accounts, no cloud sync. files stay on disk; images are downloaded and stored locally. nothing leaves your machine unless you copy it.

## license

mit · [hoiyada7-maker](https://github.com/hoiyada7-maker)
