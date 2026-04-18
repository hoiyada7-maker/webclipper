# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Web Clipper: a Python FastAPI web tool that clips web page content into self-contained Markdown files. It reads HTML from the clipboard (or from a Playwright-controlled browser tab with auto-scroll for infinite-scroll/auth-gated pages), downloads all images locally using the Playwright browser context (preserving login cookies), replaces URLs with local paths, converts to Markdown, and optionally re-embeds images as Base64 for a single portable file.

## Setup & Running

Install dependencies:
```bash
pip install fastapi uvicorn jinja2 python-multipart websockets beautifulsoup4 requests Pillow PyQt6 markdownify
```

Start the server:
```bash
python main.py
```

Access at `http://127.0.0.1:8000`. There are no automated tests — functionality is verified manually through the browser UI.

## Architecture

The core is a 3-stage pipeline triggered by `POST /api/process`:

```
Clipboard HTML
  → image_downloader.py  (extract URLs, download to ./assets/, fallback to PIL clipboard capture)
  → html_replacer.py     (rewrite <img src> and background-image CSS to ./assets/ paths)
  → md_converter.py      (convert patched HTML to Markdown)
  → output.html + output.md
```

**`main.py`** — FastAPI app, WebSocket log broadcaster (`LogManager`), clipboard reader via PyQt6, pipeline orchestrator. Mounts `/static` and `/assets` as static directories.

**`image_downloader.py`** — Downloads images via `requests` (Chrome User-Agent). Falls back to `PIL.ImageGrab` clipboard capture when HTTP fails (handles CORS/auth-blocked images). Uses a 3-tier file matching strategy: exact filename → substring match → index-based.

**`html_replacer.py`** — BeautifulSoup replaces `<img src>` / `data-src` / `data-original` attributes; regex replaces `background-image: url(...)` in inline styles.

**`md_converter.py`** — `SiemensMarkdownConverter` subclasses `markdownify.MarkdownConverter` with custom handlers for `<img>`, `<del>`, `<mark>`, `<br>`, and `<table>`. Post-processes the output with regex cleanup.

**`templates/index.html`** — Jinja2 template with vanilla JS WebSocket client that streams real-time logs from the server during pipeline execution.

## Key Constants (hardcoded in source)

- Image output directory: `./assets/` (`image_downloader.py:DEFAULT_SAVE_DIR`)
- HTTP timeout: 10s (`image_downloader.py:REQUEST_TIMEOUT`)
- Server: `host="127.0.0.1"`, `port=8000`, `reload=True` (`main.py` bottom)

## Caveats

- `PIL.ImageGrab` (clipboard fallback) only works on Windows and macOS, not Linux.
- Data URI images (`data:image/...`) in HTML are not downloaded — they are kept as-is.
- CORS or auth-protected images that block HTTP download trigger the clipboard fallback.
