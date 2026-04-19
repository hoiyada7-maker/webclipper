import asyncio
import json
import re
import sys
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import uvicorn
from bs4 import BeautifulSoup
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi import Request

# 클립보드 읽기 (PyQt6 → pyperclip 또는 플랫폼 네이티브)
try:
    from PyQt6.QtWidgets import QApplication
    from PyQt6.QtGui import QClipboard
    HAS_PYQT6 = True
except ImportError:
    HAS_PYQT6 = False

from image_downloader import process_html_images
from md_converter import run_md_pipeline

# ──────────────────────────────────────────────
# 앱 초기화
# ──────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent
OUTPUT_DIR = BASE_DIR / "output"
ASSETS_DIR = OUTPUT_DIR / "assets"
TEMPLATES  = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# 전역 변수
_qt_app = None
_browser_context = None
_playwright = None
_gui_page = None    # Tab 1: Scraper GUI
_user_page = None   # Tab 2: User browsing / login

# ── Playwright 전용 이벤트 루프 (Windows reload=True 시 SelectorEventLoop 우회) ──
_playwright_loop: asyncio.AbstractEventLoop | None = None
_playwright_thread: threading.Thread | None = None
_main_loop: asyncio.AbstractEventLoop | None = None


def _start_playwright_event_loop() -> None:
    """별도 스레드에서 ProactorEventLoop을 실행합니다."""
    global _playwright_loop
    loop = asyncio.ProactorEventLoop()
    _playwright_loop = loop
    asyncio.set_event_loop(loop)
    loop.run_forever()


async def run_playwright(coro):
    """
    Playwright 전용 루프에서 코루틴을 실행하고 결과를 반환합니다.
    - Windows : ProactorEventLoop 스레드로 브리지
    - Linux/Mac: 현재 루프에서 직접 실행
    """
    if _playwright_loop is None:
        return await coro
    loop = asyncio.get_running_loop()
    future = asyncio.run_coroutine_threadsafe(coro, _playwright_loop)
    return await loop.run_in_executor(None, future.result)


def _log_pw(text: str, level: str = "info") -> None:
    """Playwright 루프 → main 루프로 로그를 fire-and-forget 전달합니다."""
    if _main_loop is not None:
        asyncio.run_coroutine_threadsafe(log_manager.log(text, level), _main_loop)


def _broadcast_pw(data: dict) -> None:
    """Playwright 루프 → main 루프로 브로드캐스트를 fire-and-forget 전달합니다."""
    if _main_loop is not None:
        asyncio.run_coroutine_threadsafe(log_manager.broadcast(data), _main_loop)


# Windows에서 Playwright 전용 스레드 시작
if sys.platform.startswith("win"):
    _playwright_thread = threading.Thread(
        target=_start_playwright_event_loop, daemon=True, name="playwright-loop"
    )
    _playwright_thread.start()
    while _playwright_loop is None:   # 루프 준비 대기
        time.sleep(0.01)

async def _init_playwright() -> None:
    """Playwright 브라우저를 초기화합니다. (전용 ProactorEventLoop 스레드에서 실행)"""
    global _playwright, _browser_context
    from playwright.async_api import async_playwright

    _playwright = await async_playwright().start()
    _browser_context = await _playwright.chromium.launch_persistent_context(
        user_data_dir=str(BASE_DIR / ".browser_profile"),
        headless=False,
        no_viewport=True,
        args=["--start-maximized"],
    )


async def _open_browser_tabs() -> None:
    """서버 기동 후 브라우저 탭을 엽니다. (전용 ProactorEventLoop 스레드에서 실행)"""
    global _gui_page, _user_page
    await asyncio.sleep(1)
    try:
        _gui_page = await _browser_context.new_page()
        await _gui_page.goto("http://127.0.0.1:8000/")
        print("[OK] Tab 1 (GUI) opened: http://127.0.0.1:8000/")
        _user_page = await _browser_context.new_page()
        # Tab 2 — 모든 페이지 로드 시 스크롤바 항상 표시
        await _user_page.add_init_script("""
            (function() {
                const style = document.createElement('style');
                style.textContent = `
                    ::-webkit-scrollbar { width: 10px !important; height: 10px !important; }
                    ::-webkit-scrollbar-track { background: rgba(0,0,0,0.08) !important; }
                    ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.45) !important; border-radius: 5px !important; min-height: 30px !important; }
                    ::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.65) !important; }
                    html { overflow-y: scroll !important; }
                `;
                document.head
                    ? document.head.appendChild(style)
                    : document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
            })();
        """)
        await _user_page.goto("about:blank")
        print("[OK] Tab 2 opened")
        await _gui_page.bring_to_front()
    except Exception as e:
        print(f"[WARN] Tab open failed: {e}")


async def _cleanup_playwright() -> None:
    """Playwright 리소스를 정리합니다. (전용 ProactorEventLoop 스레드에서 실행)"""
    if _browser_context:
        await _browser_context.close()
    if _playwright:
        await _playwright.stop()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """서버 시작/종료 시 리소스 관리"""
    global _qt_app, _main_loop

    _main_loop = asyncio.get_running_loop()

    if HAS_PYQT6:
        _qt_app = QApplication.instance() or QApplication(sys.argv)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    (BASE_DIR / "static").mkdir(parents=True, exist_ok=True)

    try:
        await run_playwright(_init_playwright())
        # 탭 열기는 서버 기동 후 실행 (백그라운드)
        if _playwright_loop is not None:
            asyncio.run_coroutine_threadsafe(_open_browser_tabs(), _playwright_loop)
        else:
            asyncio.get_event_loop().create_task(_open_browser_tabs())
    except Exception as e:
        print(f"[ERROR] Playwright init failed: {e}")

    yield

    try:
        await run_playwright(_cleanup_playwright())
    except Exception:  # noqa
        pass

app = FastAPI(title="Web Clipper", lifespan=lifespan)

# 정적 파일 & output 마운트
app.mount("/static",  StaticFiles(directory=str(BASE_DIR / "static")),  name="static")
app.mount("/output",  StaticFiles(directory=str(OUTPUT_DIR)),            name="output")

# ──────────────────────────────────────────────
# WebSocket 로그 매니저
# ──────────────────────────────────────────────
class LogManager:
    """
    처리 진행 로그를 연결된 모든 WebSocket 클라이언트에 브로드캐스트합니다.
    """
    def __init__(self):
        self.connections: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.connections.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.connections:
            self.connections.remove(ws)

    async def broadcast(self, message: dict):
        dead = []
        for ws in self.connections:
            try:
                await ws.send_text(json.dumps(message, ensure_ascii=False))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    async def log(self, text: str, level: str = "info"):
        """level: info | success | warning | error | section"""
        await self.broadcast({"type": "log", "level": level, "text": text})

    async def progress(self, current: int, total: int):
        await self.broadcast({"type": "progress", "current": current, "total": total})

    async def done(self, stats: dict):
        await self.broadcast({"type": "done", "stats": stats})

log_manager = LogManager()

# ──────────────────────────────────────────────
# 실행 ID 생성 (파일명용)
# ──────────────────────────────────────────────
def _make_run_id(html: str) -> str:
    """
    'yyyy-mm-dd HHmmss 첫텍스트12자' 형식의 실행 ID를 생성합니다.
    파일명에 사용할 수 없는 문자는 제거합니다.
    """
    ts = datetime.now().strftime("%Y-%m-%d %H%M%S")
    soup = BeautifulSoup(html, "html.parser")
    first_text = ""
    for element in soup.find_all(string=True):
        text = element.strip()
        if text:
            first_text = text
            break
    # 파일명 사용 불가 문자 제거
    first_text = re.sub(r'[\\/:<>*?"|\n\r\t]', "", first_text)[:30].strip()
    return f"{ts} {first_text}" if first_text else ts

# ──────────────────────────────────────────────
# 브라우저 이미지 다운로드 (인증 쿠키 포함)
# ──────────────────────────────────────────────
async def _browser_download(url: str) -> tuple[bytes, str] | None:
    """브라우저 컨텍스트로 이미지를 다운로드합니다. (data, content_type) 반환"""
    if _browser_context is None:
        return None
    try:
        response = await _browser_context.request.get(url, timeout=30000)
        if response.ok:
            data         = await response.body()
            content_type = response.headers.get("content-type", "")
            return data, content_type
    except Exception as e:
        print(f"  [🌐] 브라우저 요청 실패: {e}")
    return None

def _make_browser_download_fn(loop: asyncio.AbstractEventLoop):
    """asyncio 루프에서 브라우저 다운로드를 동기적으로 호출하는 래퍼를 반환합니다."""
    effective_loop = _playwright_loop if _playwright_loop is not None else loop
    def browser_download_fn(url: str) -> tuple[bytes, str] | None:
        future = asyncio.run_coroutine_threadsafe(_browser_download(url), effective_loop)
        try:
            return future.result(timeout=35)
        except Exception:
            return None
    return browser_download_fn

# ──────────────────────────────────────────────
# 클립보드 읽기 헬퍼
# ──────────────────────────────────────────────
def _read_clipboard_html() -> tuple[bool, str]:
    """
    클립보드에서 HTML 데이터를 읽습니다.
    wl-paste(Wayland) → PyQt6 순서로 시도합니다.
    """
    import subprocess

    # Wayland: wl-paste로 직접 읽기
    try:
        result = subprocess.run(
            ["wl-paste", "--type", "text/html"],
            capture_output=True, text=True, timeout=3
        )
        if result.returncode == 0 and result.stdout.strip():
            return True, result.stdout
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # fallback: PyQt6
    if HAS_PYQT6 and _qt_app is not None:
        clipboard = _qt_app.clipboard()
        mime_data = clipboard.mimeData()
        if mime_data.hasHtml():
            return True, mime_data.html()

    return False, ""

# ──────────────────────────────────────────────
# 라우터
# ──────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """메인 페이지"""
    return TEMPLATES.TemplateResponse(request, "index.html")

@app.get("/api/clipboard")
async def read_clipboard():
    """클립보드 HTML 미리보기 API"""
    ok, html = _read_clipboard_html()
    if not ok:
        return {"ok": False, "message": "클립보드에 HTML 데이터가 없습니다.", "html": ""}
    return {"ok": True, "message": "HTML 데이터 감지됨", "html": html}

@app.post("/api/process")
async def process(request: Request):
    """
    클립보드 HTML을 읽어 전체 파이프라인을 실행합니다.
    (다운로드 → 경로 치환 → Markdown 변환)
    진행 상황은 WebSocket으로 실시간 전송됩니다.
    """
    body      = await request.json()
    base_url  = body.get("base_url",  "")
    save_html = body.get("save_html", True)
    save_md   = body.get("save_md",   True)
    embed_md  = body.get("embed_md",  True)
    html      = body.get("html",      "").strip()

    # body에 html이 없으면 서버 측 클립보드로 fallback
    if not html:
        ok, html = _read_clipboard_html()
        if not ok:
            return {"ok": False, "message": "클립보드에 HTML 데이터가 없습니다."}

    # 비동기 작업으로 파이프라인 실행
    asyncio.create_task(
        _run_pipeline(html, base_url, save_html, save_md, embed_md)
    )
    return {"ok": True, "message": "처리를 시작했습니다. 로그를 확인하세요."}

async def _run_pipeline(
    html      : str,
    base_url  : str,
    save_html : bool,
    save_md   : bool,
    embed_md  : bool,
):
    """파이프라인을 비동기로 실행하며 WebSocket으로 로그 전송"""
    import io
    import sys

    do_md       = save_md or embed_md   # 둘 중 하나라도 True면 MD 생성
    run_id      = _make_run_id(html)
    output_html = str(OUTPUT_DIR / f"{run_id}.html")
    output_md   = str(OUTPUT_DIR / f"{run_id}.md")
    save_dir    = str(ASSETS_DIR)

    await log_manager.log("=" * 48, "section")
    await log_manager.log("🚀 파이프라인 시작", "section")
    await log_manager.log("=" * 48, "section")

    # stdout을 가로채어 WebSocket으로 전달
    class WSStream(io.StringIO):
        def __init__(self, loop):
            super().__init__()
            self._loop = loop

        def write(self, text: str):
            text = text.strip()
            if text:
                level = (
                    "success" if "✅" in text else
                    "error"   if "❌" in text or "💀" in text else
                    "warning" if "⚠️" in text or "⏭️" in text else
                    "section" if "===" in text or "📊" in text else
                    "info"
                )
                asyncio.run_coroutine_threadsafe(
                    log_manager.log(text, level), self._loop
                )
            return len(text)

        def flush(self):
            pass

    loop       = asyncio.get_event_loop()
    old_stdout = sys.stdout
    sys.stdout = WSStream(loop)

    browser_download_fn = _make_browser_download_fn(loop) if _browser_context else None

    try:
        stats = await asyncio.to_thread(
            process_html_images,
            html                = html,
            base_url            = base_url,
            save_dir            = save_dir,
            run_id              = run_id,
            replace_path        = True,
            output_html         = output_html,
            convert_md          = do_md,
            output_md           = output_md,
            browser_download_fn = browser_download_fn,
        )
        # ── 후처리: 선택된 출력 형식만 남기기 ──
        md_path   = Path(output_md)
        html_path = Path(output_html)

        # 1. MD(이미지포함)추출: 생성된 MD를 읽어 Base64 임베드 → _embedded.md 저장
        if embed_md and do_md and md_path.exists():
            await log_manager.log("📎 이미지 Base64 임베드 중...", "info")
            md_text  = md_path.read_text(encoding="utf-8")
            result   = await asyncio.to_thread(_embed_md_images, md_text, OUTPUT_DIR)
            out_embedded = OUTPUT_DIR / f"{run_id}_embedded.md"
            out_embedded.write_text(result, encoding="utf-8")
            img_count = result.count("data:image/")
            await log_manager.log(f"✅ 임베드 완료 — 이미지 {img_count}개", "success")

        # 2. save_html=False 이면 HTML 파일 삭제
        if not save_html and html_path.exists():
            html_path.unlink()

        # 3. save_md=False 이면 원본 MD 파일 삭제
        if not save_md and md_path.exists():
            md_path.unlink()

        await log_manager.done({
            "success"     : stats.get("success", 0),
            "failed"      : stats.get("failed", 0),
            "skipped"     : stats.get("skipped", 0),
            "total"       : stats.get("total", 0),
            "output_html" : stats.get("output_html", ""),
            "output_md"   : stats.get("output_md", ""),
            "run_id"      : run_id,
        })

    except Exception as e:
        await log_manager.log(f"❌ 오류 발생: {e}", "error")
    finally:
        sys.stdout = old_stdout

@app.get("/api/download")
async def download_file(path: str):
    """output/ 폴더 내 파일 다운로드 (?path=파일명)"""
    file_path = (OUTPUT_DIR / path).resolve()
    # output/ 폴더 밖 접근 차단
    if not str(file_path).startswith(str(OUTPUT_DIR.resolve())):
        return HTMLResponse("허용되지 않은 경로입니다.", status_code=403)
    if not file_path.exists():
        return HTMLResponse("파일이 존재하지 않습니다.", status_code=404)

    filename   = file_path.name
    media_type = "text/markdown" if filename.endswith(".md") else "text/html"
    return FileResponse(file_path, filename=filename, media_type=media_type)

@app.post("/api/scroll/wheel_test")
async def scroll_wheel_test():
    """mouse.wheel 실행 전후로 모든 요소의 scrollTop 변화를 추적합니다."""
    if _user_page is None or _user_page.is_closed():
        return {"ok": False}

    async def _impl():
        await _user_page.bring_to_front()

        async def _snapshot():
            results = []
            for frame in _user_page.frames:
                try:
                    data = await frame.evaluate("""() => {
                        const changed = [];
                        for (const el of document.querySelectorAll('*')) {
                            if (el.scrollTop > 0 || el.scrollLeft > 0) {
                                changed.push({
                                    tag: el.tagName, id: el.id||'',
                                    cls: (el.className||'').toString().slice(0,60),
                                    scrollTop: el.scrollTop, scrollLeft: el.scrollLeft,
                                    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
                                });
                            }
                        }
                        return {
                            url: location.href,
                            windowScrollY: window.scrollY,
                            scrolledEls: changed,
                        };
                    }""")
                    results.append(data)
                except Exception as e:
                    results.append({"url": frame.url, "error": str(e)})
            return results

        w = await _user_page.evaluate("() => window.innerWidth")
        h = await _user_page.evaluate("() => window.innerHeight")
        await _user_page.mouse.move(w // 2, h // 2)
        before = await _snapshot()
        fp_before = await _get_scroll_fingerprint()
        await _user_page.mouse.wheel(0, 600)
        await asyncio.sleep(0.8)
        after = await _snapshot()
        fp_after = await _get_scroll_fingerprint()
        return {
            "ok": True,
            "before": before, "after": after,
            "fp_before": fp_before, "fp_after": fp_after,
        }

    return await run_playwright(_impl())


@app.get("/api/scroll/frame_debug")
async def scroll_frame_debug():
    """모든 frame 의 스크롤 컨테이너를 진단합니다."""
    if _user_page is None or _user_page.is_closed():
        return {"ok": False, "message": "Tab 2 없음"}

    async def _impl():
        result = []
        for frame in _user_page.frames:
            try:
                info = await frame.evaluate("""() => {
                    const all = Array.from(document.querySelectorAll('*'));
                    const candidates = [];
                    for (const el of all) {
                        const diff = el.scrollHeight - el.clientHeight;
                        if (diff > 50) {
                            const st = window.getComputedStyle(el);
                            candidates.push({
                                tag: el.tagName, id: el.id || '',
                                cls: (el.className||'').toString().slice(0,80),
                                scrollTop: el.scrollTop, scrollHeight: el.scrollHeight,
                                clientHeight: el.clientHeight, maxScroll: diff,
                                overflowY: st.overflowY,
                            });
                        }
                    }
                    candidates.sort((a,b) => b.maxScroll - a.maxScroll);
                    return {
                        url: location.href,
                        windowScrollY: window.scrollY,
                        docScrollHeight: document.documentElement.scrollHeight,
                        innerHeight: window.innerHeight,
                        topEls: candidates.slice(0,3),
                    };
                }""")
                result.append(info)
            except Exception as e:
                result.append({"url": frame.url, "error": str(e)})
        return {"ok": True, "frames": result}

    return await run_playwright(_impl())


@app.post("/api/scroll/start")
async def scroll_start():
    """Tab 2 에서 1초마다 자동 스크롤 → 바닥 도달 시 GUI 탭으로 포커스 전환 + done 이벤트 전송"""
    if _user_page is None or _user_page.is_closed():
        return {"ok": False, "message": "Tab 2 가 열려 있지 않습니다."}
    if _playwright_loop is not None:
        asyncio.run_coroutine_threadsafe(_auto_scroll(), _playwright_loop)
    else:
        asyncio.create_task(_auto_scroll())
    return {"ok": True, "message": "자동 스크롤을 시작했습니다."}

_DEEP_SCROLL_JS = """() => {
    // Shadow DOM 포함 전체 트리에서 최대 scrollTop 반환
    function maxScrollInRoot(root) {
        let best = 0;
        try { best = Math.max(best, root.scrollTop || 0); } catch(e) {}
        const walker = document.createTreeWalker
            ? null : null;  // TreeWalker는 shadow 불가
        const scan = (node) => {
            try {
                if (node.scrollTop > best) best = node.scrollTop;
                if (node.shadowRoot) {
                    const r = maxScrollInRoot(node.shadowRoot);
                    if (r > best) best = r;
                }
            } catch(e) {}
            for (const child of (node.children || [])) scan(child);
        };
        scan(root);
        return best;
    }
    return {
        winScrollY : window.scrollY,
        deepMax    : maxScrollInRoot(document.documentElement),
        bodyH      : document.body ? document.body.scrollHeight : 0,
        docH       : document.documentElement.scrollHeight,
        innerH     : window.innerHeight,
    };
}"""

async def _get_scroll_fingerprint() -> dict:
    """모든 프레임에서 Shadow DOM 포함 스크롤 위치 수집."""
    result = {}
    for i, frame in enumerate(_user_page.frames):
        try:
            info = await frame.evaluate(_DEEP_SCROLL_JS)
            result[f"frame{i}"] = info
        except Exception:
            pass
    return result


async def _scroll_page_down():
    """클릭 없이 mouse.wheel 만으로 스크롤 (클릭하면 링크로 이동될 수 있음)."""
    # no_viewport=True 환경에서는 viewport_size가 None → JS로 실제 높이 읽기
    inner_h = await _user_page.evaluate("() => window.innerHeight")
    await _user_page.mouse.wheel(0, int(inner_h * 1.7))


def _fingerprint_max(fp: dict) -> int:
    """fingerprint dict 에서 가장 큰 스크롤 값 반환."""
    best = 0
    for info in fp.values():
        for key in ("winScrollY", "deepMax"):
            v = info.get(key, 0)
            if v > best:
                best = v
    return best


async def _auto_scroll():
    """
    Tab 2 를 1초 간격으로 스크롤합니다.
    아래 조건 중 하나가 되면 완료로 판정합니다:
      1. deepMax 가 3회 연속 변화 없음 (바닥 도달)
      2. URL 이 초기값과 달라진 뒤 deepMax 가 다시 3회 연속 안정 (SPA 다음 섹션 진입)
    """
    _log_pw("🖱️ 자동 스크롤 시작 (Tab 2)", "info")
    try:
        await _user_page.bring_to_front()
        w = await _user_page.evaluate("() => window.innerWidth")
        h = await _user_page.evaluate("() => window.innerHeight")
        await _user_page.mouse.move(w // 2, h // 2)

        start_url    = _user_page.url
        stable_count = 0
        prev_max     = -1
        scroll_count = 0
        MIN_SCROLLS  = 3
        MAX_SCROLLS  = 300   # 최대 5분 (1초 * 300)

        while scroll_count < MAX_SCROLLS:
            fp      = await _get_scroll_fingerprint()
            cur_max = _fingerprint_max(fp)
            cur_url = _user_page.url

            if scroll_count >= MIN_SCROLLS:
                url_changed = cur_url != start_url
                moved       = abs(cur_max - prev_max) >= 2

                if not moved:
                    stable_count += 1
                    _log_pw(
                        f"   바닥 감지 중 ({stable_count}/3) — "
                        f"pos={cur_max} {'[URL 변경됨]' if url_changed else ''}",
                        "info"
                    )
                else:
                    stable_count = 0

                # 3회 연속 안정 → 완료
                if stable_count >= 3:
                    break

            prev_max = cur_max
            await _scroll_page_down()
            scroll_count += 1
            _log_pw(f"   스크롤 #{scroll_count} — pos={cur_max}", "info")
            await asyncio.sleep(1)
        else:
            _log_pw("⚠️ 최대 스크롤 횟수 도달 (300회)", "warning")

        if _gui_page and not _gui_page.is_closed():
            await _gui_page.bring_to_front()
        _broadcast_pw({"type": "scroll_done"})
        _log_pw("✅ 스크롤 완료 — GUI 탭으로 전환됨", "success")
    except Exception as e:
        _log_pw(f"⚠️ 자동 스크롤 오류: {e}", "warning")


@app.post("/api/user_page/navigate")
async def user_page_navigate(request: Request):
    """Tab 2 를 지정 URL 로 이동합니다."""
    body = await request.json()
    url  = body.get("url", "")
    if not url:
        return {"ok": False, "message": "url 필드가 없습니다."}
    if _user_page is None or _user_page.is_closed():
        return {"ok": False, "message": "Tab 2 가 열려 있지 않습니다."}

    async def _impl():
        try:
            await _user_page.bring_to_front()
            await _user_page.goto(url, wait_until="networkidle", timeout=45000)
            return {"ok": True, "url": _user_page.url}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    return await run_playwright(_impl())


@app.get("/api/scroll/debug")
async def scroll_debug():
    """Tab 2 의 스크롤 상태를 진단합니다."""
    if _user_page is None or _user_page.is_closed():
        return {"ok": False, "message": "Tab 2 가 열려 있지 않습니다."}

    async def _impl():
        info = await _user_page.evaluate("""() => {
            const win = {
                scrollY            : window.scrollY,
                innerHeight        : window.innerHeight,
                docScrollHeight    : document.documentElement.scrollHeight,
                bodyScrollHeight   : document.body ? document.body.scrollHeight : 0,
                docClientHeight    : document.documentElement.clientHeight,
            };
            const all = Array.from(document.querySelectorAll('*'));
            const candidates = [];
            for (const el of all) {
                const diff = el.scrollHeight - el.clientHeight;
                if (diff > 50) {
                    const st = window.getComputedStyle(el);
                    candidates.push({
                        tag         : el.tagName,
                        id          : el.id || '',
                        cls         : (el.className || '').toString().slice(0, 80),
                        scrollTop   : el.scrollTop,
                        scrollHeight: el.scrollHeight,
                        clientHeight: el.clientHeight,
                        maxScroll   : diff,
                        overflowY   : st.overflowY,
                    });
                }
            }
            candidates.sort((a, b) => b.maxScroll - a.maxScroll);
            const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({
                src: f.src, id: f.id, width: f.offsetWidth, height: f.offsetHeight
            }));
            return { window: win, topScrollEls: candidates.slice(0, 5), iframes };
        }""")
        return {"ok": True, "info": info, "url": _user_page.url}

    return await run_playwright(_impl())


@app.get("/api/user_page/html")
async def get_user_page_html():
    """Tab 2 현재 페이지의 outerHTML 을 반환합니다."""
    if _user_page is None or _user_page.is_closed():
        return {"ok": False, "html": "", "message": "Tab 2 가 열려 있지 않습니다."}

    async def _impl():
        try:
            html = await _user_page.evaluate("() => document.documentElement.outerHTML")
            url  = _user_page.url
            return {"ok": True, "html": html, "url": url}
        except Exception as e:
            return {"ok": False, "html": "", "message": str(e)}

    return await run_playwright(_impl())


def _embed_md_images(md_text: str, output_dir: Path) -> str:
    """MD 내 로컬 이미지 경로를 Base64 data URI 로 인라인 치환하여 반환합니다."""
    import base64, mimetypes, re

    resolved = output_dir.resolve()

    def _replace(match: re.Match) -> str:
        alt  = match.group(1)
        path = match.group(2).strip()
        if path.startswith("data:") or path.startswith("http"):
            return match.group(0)
        rel       = path.lstrip("./").lstrip("/")
        file_path = (resolved / rel).resolve()
        if not str(file_path).startswith(str(resolved)):
            return match.group(0)
        if not file_path.exists():
            return match.group(0)
        mime = mimetypes.guess_type(str(file_path))[0] or "image/png"
        b64  = base64.b64encode(file_path.read_bytes()).decode()
        return f"![{alt}](data:{mime};base64,{b64})"

    return re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', _replace, md_text)


@app.post("/api/embed_images")
async def embed_images(request: Request):
    """
    MD 파일 내 이미지 경로를 Base64 데이터 URI 로 인라인 치환합니다.
    이미지 경로는 OUTPUT_DIR 기준 상대경로로 해석합니다.
    """
    body     = await request.json()
    md_text  = body.get("md", "")
    filename = body.get("filename", "embedded.md")

    if not md_text:
        return {"ok": False, "message": "MD 내용이 없습니다."}

    result    = _embed_md_images(md_text, OUTPUT_DIR)
    img_count = result.count("data:image/")

    out_name = Path(filename).stem + "_embedded.md"
    out_path = OUTPUT_DIR / out_name
    out_path.write_text(result, encoding="utf-8")

    return {
        "ok"       : True,
        "filename" : out_name,
        "img_count": img_count,
        "size"     : out_path.stat().st_size,
    }


@app.post("/api/extract_images")
async def extract_images(request: Request):
    """
    MD 파일 내 Base64 data URI 이미지를 실제 파일로 추출하고,
    MD의 이미지 링크를 로컬 경로(./assets/파일명)로 교체합니다.
    결과 파일: output/<원본명>_extracted.md
    이미지 파일: output/assets/<원본명>_img_001.png ...
    """
    import base64, re

    body     = await request.json()
    md_text  = body.get("md", "")
    filename = body.get("filename", "document.md")

    if not md_text:
        return {"ok": False, "message": "MD 내용이 없습니다."}

    stem      = Path(filename).stem          # 확장자 제거
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    counter   = 0
    replaced  = 0

    def _extract(match: re.Match) -> str:
        nonlocal counter, replaced
        alt      = match.group(1)
        data_uri = match.group(2).strip()

        if not data_uri.startswith("data:image/"):
            return match.group(0)   # data URI 이미지가 아니면 그대로

        # data:image/png;base64,xxxx  파싱
        m = re.match(r"data:image/(\w+);base64,(.+)", data_uri, re.DOTALL)
        if not m:
            return match.group(0)

        ext       = m.group(1).lower()
        if ext == "jpeg":
            ext = "jpg"
        raw_b64   = m.group(2).strip()

        counter  += 1
        img_name  = f"{stem}_img_{counter:03d}.{ext}"
        img_path  = ASSETS_DIR / img_name

        try:
            img_path.write_bytes(base64.b64decode(raw_b64))
            replaced += 1
            return f"![{alt}](./assets/{img_name})"
        except Exception:
            return match.group(0)   # 디코드 실패 시 원본 유지

    result   = re.sub(r'!\[([^\]]*)\]\((data:image/[^)]+)\)', _extract, md_text, flags=re.DOTALL)

    out_name = f"{stem}_extracted.md"
    out_path = OUTPUT_DIR / out_name
    out_path.write_text(result, encoding="utf-8")

    return {
        "ok"       : True,
        "filename" : out_name,
        "img_count": replaced,
        "size"     : out_path.stat().st_size,
    }


@app.post("/api/extract_images_by_path")
async def extract_images_by_path(request: Request):
    """
    output/ 폴더 내 MD 파일을 경로로 지정하여 서버에서 직접 처리합니다.
    업로드 불필요 — 파일명(또는 상대경로)만 전달하면 됩니다.
    """
    import base64, re

    body     = await request.json()
    filename = body.get("filename", "")

    if not filename:
        return {"ok": False, "message": "파일명을 입력하세요."}

    src_path = (OUTPUT_DIR / filename).resolve()
    # 보안: output/ 폴더 밖 접근 차단
    if not str(src_path).startswith(str(OUTPUT_DIR.resolve())):
        return {"ok": False, "message": "허용되지 않은 경로입니다."}
    if not src_path.exists():
        return {"ok": False, "message": f"파일을 찾을 수 없습니다: {filename}"}

    md_text  = src_path.read_text(encoding="utf-8")
    stem     = src_path.stem
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    counter  = 0
    replaced = 0

    def _extract(match: re.Match) -> str:
        nonlocal counter, replaced
        alt      = match.group(1)
        data_uri = match.group(2).strip()

        if not data_uri.startswith("data:image/"):
            return match.group(0)

        m = re.match(r"data:image/(\w+);base64,(.+)", data_uri, re.DOTALL)
        if not m:
            return match.group(0)

        ext = m.group(1).lower()
        if ext == "jpeg":
            ext = "jpg"
        raw_b64 = m.group(2).strip()

        counter  += 1
        img_name  = f"{stem}_img_{counter:03d}.{ext}"
        img_path  = ASSETS_DIR / img_name

        try:
            img_path.write_bytes(base64.b64decode(raw_b64))
            replaced += 1
            return f"![{alt}](./assets/{img_name})"
        except Exception:
            return match.group(0)

    result   = re.sub(r'!\[([^\]]*)\]\((data:image/[^)]+)\)', _extract, md_text, flags=re.DOTALL)

    out_name = f"{stem}_extracted.md"
    out_path = OUTPUT_DIR / out_name
    out_path.write_text(result, encoding="utf-8")

    return {
        "ok"       : True,
        "filename" : out_name,
        "img_count": replaced,
        "size"     : out_path.stat().st_size,
        "src"      : str(src_path.name),
    }


@app.get("/api/output_files")
async def list_output_files():
    """output/ 폴더의 .md 파일 목록 반환"""
    files = sorted(
        [f.name for f in OUTPUT_DIR.glob("*.md") if not f.name.endswith("_extracted.md")],
        reverse=True
    )
    return {"files": files}

# ──────────────────────────────────────────────
# 수동 글자/그림 추출 (글자추출MD로변환)
# ──────────────────────────────────────────────
@app.get("/api/md_images")
async def get_md_images(filename: str):
    """지정된 MD 파일을 파싱하여 내부 이미지들의 절대 경로 목록을 반환합니다."""
    import re, urllib.parse
    if not filename:
        return {"ok": False, "message": "파일명이 없습니다."}
    
    file_path = (OUTPUT_DIR / filename).resolve()
    if not file_path.exists():
        return {"ok": False, "message": "파일을 찾을 수 없습니다."}
        
    content = file_path.read_text(encoding="utf-8")
    pattern = re.compile(r'!\[.*?\]\((.*?)\)')
    image_paths = pattern.findall(content)
    
    abs_images = []
    for p in image_paths:
        if p.startswith("data:") or p.startswith("http"): continue
        decoded = urllib.parse.unquote(p)
        abs_p = (OUTPUT_DIR / decoded).resolve()
        if abs_p.exists():
            abs_images.append(str(abs_p))
            
    return {"ok": True, "images": abs_images}

@app.get("/api/image_raw")
async def get_image_raw(path: str):
    """주어진 절대 경로의 이미지를 반환합니다."""
    from fastapi.responses import FileResponse
    p = Path(path).resolve()
    if p.exists():
        return FileResponse(p)
    return {"ok": False}

async def _windows_ocr(img_path_str: str) -> str:
    """Windows 내장 OCR 엔진으로 텍스트 인식."""
    import winsdk.windows.media.ocr as win_ocr
    import winsdk.windows.globalization as glob
    import winsdk.windows.graphics.imaging as imaging
    import winsdk.windows.storage as storage

    lang = glob.Language("ko-KR")
    if not win_ocr.OcrEngine.is_language_supported(lang):
        return ""
    engine = win_ocr.OcrEngine.try_create_from_language(lang)
    file   = await storage.StorageFile.get_file_from_path_async(img_path_str)
    stream = await file.open_async(storage.FileAccessMode.READ)
    decoder = await imaging.BitmapDecoder.create_async(stream)
    bitmap  = await decoder.get_software_bitmap_async()
    result  = await engine.recognize_async(bitmap)
    return "\n".join(line.text for line in result.lines)


@app.post("/api/preview_extract")
async def preview_extract(request: Request):
    """영역별 크롭 이미지 + Windows OCR 텍스트를 미리보기용으로 반환."""
    import base64, io, tempfile, os
    import cv2, numpy as np
    from PIL import Image

    body      = await request.json()
    filename  = body.get("filename", "")
    boxes_dict = body.get("boxes", {})

    if not filename:
        return {"ok": False, "message": "파일명 누락"}

    regions = []
    region_id = 0

    for img_path_str, boxes in boxes_dict.items():
        if not boxes:
            continue
        img_path = Path(img_path_str)
        if not img_path.exists():
            continue

        img_array = np.fromfile(img_path_str, np.uint8)
        image     = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        image_rgb = image[..., ::-1]

        for box in sorted(boxes, key=lambda b: b["y"]):
            if box.get("full"):
                x1, y1 = 0, 0
                x2, y2 = image_rgb.shape[1], image_rgb.shape[0]
            else:
                x1 = max(0, box["x"])
                y1 = max(0, box["y"])
                x2 = min(image_rgb.shape[1], box["x"] + box["w"])
                y2 = min(image_rgb.shape[0], box["y"] + box["h"])
            cropped = image_rgb[y1:y2, x1:x2]

            pil_img = Image.fromarray(cropped)
            buf = io.BytesIO()
            pil_img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode()

            ocr_text = ""
            if box["type"] == "text":
                tf = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
                tmp_path = tf.name
                tf.close()
                try:
                    pil_img.save(tmp_path)
                    abs_path = str(Path(tmp_path).resolve())
                    ocr_text = await _windows_ocr(abs_path)
                except Exception:
                    ocr_text = ""
                finally:
                    try: os.unlink(tmp_path)
                    except: pass

            regions.append({
                "id":       region_id,
                "img_path": img_path_str,
                "box":      box,
                "orig_type": box["type"],
                "cropped_b64": b64,
                "ocr_text": ocr_text,
            })
            region_id += 1

    return {"ok": True, "regions": regions}


@app.post("/api/ocr_region")
async def ocr_region(request: Request):
    """단일 영역을 재OCR하여 텍스트를 반환합니다."""
    import base64, io, tempfile, os
    import cv2, numpy as np
    from PIL import Image

    body         = await request.json()
    img_path_str = body.get("img_path", "")
    box          = body.get("box", {})

    img_path = Path(img_path_str)
    if not img_path.exists():
        return {"ok": False, "message": "이미지 파일 없음"}

    try:
        arr    = np.fromfile(img_path_str, np.uint8)
        image  = cv2.imdecode(arr, cv2.IMREAD_COLOR)[..., ::-1]
        x1, y1 = max(0, box["x"]), max(0, box["y"])
        x2, y2 = min(image.shape[1], box["x"] + box["w"]), min(image.shape[0], box["y"] + box["h"])
        cropped = image[y1:y2, x1:x2]

        pil_img = Image.fromarray(cropped)
        tf = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        tmp_path = tf.name
        tf.close()
        try:
            pil_img.save(tmp_path)
            ocr_text = await _windows_ocr(str(Path(tmp_path).resolve()))
        finally:
            try: os.unlink(tmp_path)
            except: pass

        return {"ok": True, "ocr_text": ocr_text}
    except Exception as e:
        return {"ok": False, "message": str(e)}


@app.post("/api/extract_text_manual")
async def extract_text_manual(request: Request):
    """미리보기에서 확정된 regions 목록으로 MD를 생성합니다."""
    body     = await request.json()
    filename = body.get("filename", "")
    regions  = body.get("regions", [])

    if not filename:
        return {"ok": False, "message": "파일명 누락"}

    stem     = Path(filename).stem
    out_name = f"{stem}_OCR.md"
    if (OUTPUT_DIR / out_name).exists():
        ts       = datetime.now().strftime("%Y%m%d%H%M%S")
        out_name = f"{stem}_OCR_{ts}.md"

    asyncio.create_task(_run_manual_extract(filename, regions, out_name))
    return {"ok": True, "output_path": f"output/{out_name}"}


async def _run_manual_extract(filename: str, regions: list, out_name: str):
    await log_manager.log("=" * 48, "section")
    await log_manager.log(f"🚀 OCR 변환 시작: {filename}", "section")

    try:
        import cv2, numpy as np
        from PIL import Image
        import urllib.parse, re
        from collections import defaultdict
        from urllib.parse import unquote

        orig_md_path = OUTPUT_DIR / filename
        if not orig_md_path.exists():
            await log_manager.log(f"❌ 원본 MD 파일 없음: {filename}", "error")
            return

        stem    = Path(filename).stem
        fig_ts  = datetime.now().strftime("%Y%m%d_%H%M%S")
        counter = [0]
        logs    = []   # (message, level) — re.sub은 동기라 나중에 일괄 로깅

        # img_path(절대경로) → 해당 이미지의 regions 목록
        regions_by_abs: dict[str, list] = defaultdict(list)
        for r in regions:
            key = str(Path(r["img_path"]).resolve())
            regions_by_abs[key].append(r)

        def replace_image(match: re.Match) -> str:
            rel_path = match.group(2)
            if rel_path.startswith("http") or rel_path.startswith("data:"):
                return match.group(0)

            abs_path = str((OUTPUT_DIR / unquote(rel_path)).resolve())
            matched  = regions_by_abs.get(abs_path, [])
            if not matched:
                return match.group(0)   # 선택 없는 이미지 → 원본 유지

            parts = []
            for region in matched:
                final_type = region.get("final_type", "figure")
                ocr_text   = region.get("ocr_text", "").strip()

                if final_type == "text" and ocr_text:
                    parts.append(ocr_text)
                    logs.append((f"  텍스트 삽입: {ocr_text[:40]}…", "success"))
                else:
                    box = region["box"]
                    try:
                        arr    = np.fromfile(region["img_path"], np.uint8)
                        img    = cv2.imdecode(arr, cv2.IMREAD_COLOR)[..., ::-1]
                        x1, y1 = max(0, box["x"]), max(0, box["y"])
                        x2, y2 = min(img.shape[1], box["x"] + box["w"]), min(img.shape[0], box["y"] + box["h"])
                        crop   = img[y1:y2, x1:x2]
                        prefix = "txt" if region.get("orig_type") == "text" else "fig"
                        counter[0] += 1
                        img_name = f"{stem}_{prefix}_{fig_ts}_{counter[0]}.png"
                        Image.fromarray(crop).save(ASSETS_DIR / img_name)
                        safe = urllib.parse.quote(img_name)
                        parts.append(f"![Figure](./assets/{safe})")
                        logs.append((f"  그림 저장: {img_name}", "success"))
                    except Exception as e:
                        logs.append((f"  그림 저장 실패: {e}", "error"))
                        parts.append(match.group(0))

            return "\n\n".join(parts)

        orig_content = orig_md_path.read_text(encoding="utf-8")
        new_content  = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', replace_image, orig_content)

        for msg, lvl in logs:
            await log_manager.log(msg, lvl)

        out_path = OUTPUT_DIR / out_name
        out_path.write_text(new_content, encoding="utf-8")
        await log_manager.log(f"✅ OCR MD 생성 완료: {out_name}", "success")

    except Exception:
        import traceback
        await log_manager.log(f"❌ OCR 변환 오류:\n{traceback.format_exc()}", "error")



@app.websocket("/ws/logs")
async def websocket_logs(ws: WebSocket):
    """실시간 로그 스트리밍 WebSocket"""
    await log_manager.connect(ws)
    try:
        while True:
            await ws.receive_text()   # 클라이언트 ping 유지
    except WebSocketDisconnect:
        log_manager.disconnect(ws)

# ──────────────────────────────────────────────
# 진입점
# ──────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)