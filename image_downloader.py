import os
import re
import time
import requests
from pathlib import Path
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup
from PIL import ImageGrab, Image
from html_replacer import replace_all_image_paths
from md_converter import run_md_pipeline

# ──────────────────────────────────────────────
# 설정 상수
# ──────────────────────────────────────────────
DEFAULT_SAVE_DIR = "./assets"
REQUEST_TIMEOUT  = 10       # 초
REQUEST_HEADERS  = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

# ──────────────────────────────────────────────
# 유틸리티
# ──────────────────────────────────────────────
def _ensure_dir(path: str) -> Path:
    """저장 폴더가 없으면 자동 생성"""
    save_path = Path(path)
    save_path.mkdir(parents=True, exist_ok=True)
    return save_path

def _safe_filename(url: str, index: int, ext: str = "") -> str:
    """
    URL에서 안전한 파일명 생성.
    파일명을 추출할 수 없으면 img_001.png 형식으로 대체.
    """
    parsed   = urlparse(url)
    basename = os.path.basename(parsed.path).strip()

    # 파일명이 없거나 확장자가 없는 경우 기본 이름 사용
    if not basename or "." not in basename:
        ext      = ext or ".png"
        basename = f"img_{index:03d}{ext}"

    # 파일명에 사용 불가한 문자 제거
    basename = re.sub(r'[\\/:*?"<>|]', "_", basename)
    return basename

def _unique_path(save_dir: Path, filename: str) -> Path:
    """동일 파일명이 존재하면 img_001(1).png 형식으로 넘버링"""
    target = save_dir / filename
    if not target.exists():
        return target

    stem   = target.stem
    suffix = target.suffix
    counter = 1
    while target.exists():
        target = save_dir / f"{stem}({counter}){suffix}"
        counter += 1
    return target

# ──────────────────────────────────────────────
# 핵심 기능 1 : HTML에서 img src 추출
# ──────────────────────────────────────────────
def extract_img_urls(html: str, base_url: str = "") -> list[dict]:
    """
    BeautifulSoup4로 HTML 내 모든 <img> 태그의 src를 추출합니다.

    Parameters
    ----------
    html     : 클립보드에서 읽어온 HTML 문자열
    base_url : 상대 경로를 절대 경로로 변환할 기준 URL (옵션)

    Returns
    -------
    [{"index": int, "src": str, "alt": str}, ...]
    """
    soup    = BeautifulSoup(html, "html.parser")
    img_tags = soup.find_all("img")

    result = []
    for idx, tag in enumerate(img_tags, start=1):
        src = (
            tag.get("src") or
            tag.get("data-src") or       # lazy-load 대응
            tag.get("data-original") or  # 일부 사이트 lazy-load 속성
            ""
        ).strip()

        if not src:
            print(f"  [⚠️  {idx}] src 속성 없음 → 건너뜀")
            continue

        # 상대 경로 → 절대 경로 변환
        if base_url and not src.startswith(("http://", "https://", "data:")):
            src = urljoin(base_url, src)

        result.append({
            "index": idx,
            "src"  : src,
            "alt"  : tag.get("alt", ""),
        })
        print(f"  [🔍 {idx}] 발견: {src[:80]}{'...' if len(src) > 80 else ''}")

    print(f"\n총 {len(result)}개의 이미지 URL 추출 완료.\n")
    return result

# ──────────────────────────────────────────────
# 핵심 기능 2 : requests로 이미지 다운로드
# ──────────────────────────────────────────────
EXT_MAP = {
    "image/jpeg"   : ".jpg",
    "image/png"    : ".png",
    "image/gif"    : ".gif",
    "image/webp"   : ".webp",
    "image/svg+xml": ".svg",
    "image/bmp"    : ".bmp",
}

def download_image(
    src             : str,
    index           : int,
    save_dir        : Path,
    filename_prefix : str = "",
    browser_download_fn=None,
) -> tuple[bool, Path | None]:
    """
    단일 이미지를 다운로드합니다.
    1순위: browser_download_fn (브라우저 쿠키/세션 포함)
    2순위: requests (일반 HTTP)

    Returns
    -------
    (성공 여부, 저장된 파일 경로 or None)
    """
    if src.startswith("data:"):
        print(f"  [⏭️  {index}] data URI → 건너뜀")
        return False, None

    def _save(data: bytes, content_type: str) -> Path:
        ext       = EXT_MAP.get(content_type.split(";")[0].strip(), "")
        base_name = _safe_filename(src, index, ext)
        filename  = f"{filename_prefix}_{base_name}" if filename_prefix else base_name
        filepath  = _unique_path(save_dir, filename)
        filepath.write_bytes(data)
        return filepath

    # ── 1순위: 브라우저로 다운로드 (인증 쿠키 포함) ──
    if browser_download_fn:
        try:
            result = browser_download_fn(src)
            if result:
                data, content_type = result
                filepath = _save(data, content_type)
                print(f"  [✅ {index}] 브라우저 다운로드 성공 → {filepath}")
                return True, filepath
        except Exception as e:
            print(f"  [🔄 {index}] 브라우저 다운로드 실패: {e} → requests 시도")

    # ── 2순위: requests ──
    try:
        response = requests.get(
            src,
            headers=REQUEST_HEADERS,
            timeout=REQUEST_TIMEOUT,
            stream=True,
        )
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "")
        data = response.content
        filepath = _save(data, content_type)
        print(f"  [✅ {index}] 다운로드 성공 → {filepath}")
        return True, filepath

    except requests.exceptions.Timeout:
        print(f"  [⏱️  {index}] 타임아웃 ({REQUEST_TIMEOUT}s 초과)")
    except requests.exceptions.SSLError:
        print(f"  [🔒 {index}] SSL 오류")
    except requests.exceptions.ConnectionError:
        print(f"  [🌐 {index}] 연결 실패")
    except requests.exceptions.HTTPError as e:
        print(f"  [🚫 {index}] HTTP 오류: {e}")
    except Exception as e:
        print(f"  [❌ {index}] 알 수 없는 오류: {e}")

    return False, None

# ──────────────────────────────────────────────
# 핵심 기능 3 : Pillow ImageGrab으로 폴백 캡처
# ──────────────────────────────────────────────
def grab_clipboard_image(index: int, save_dir: Path, filename_prefix: str = "") -> tuple[bool, Path | None]:
    """
    클립보드에 픽셀 이미지(비트맵)가 있으면 Pillow ImageGrab으로 캡처 후 저장.
    다운로드 실패 시 폴백으로 호출됩니다.

    Returns
    -------
    (성공 여부, 저장된 파일 경로 or None)
    """
    try:
        image = ImageGrab.grabclipboard()

        if image is None:
            print(f"  [🖼️  {index}] 클립보드에 픽셀 이미지 없음 → 건너뜀")
            return False, None

        if not isinstance(image, Image.Image):
            print(f"  [🖼️  {index}] 클립보드 데이터가 이미지 형식이 아님")
            return False, None

        # RGBA → RGB 변환 (JPEG 저장 시 필요)
        if image.mode in ("RGBA", "P"):
            image = image.convert("RGB")

        base_name = f"clipboard_img_{index:03d}.png"
        filename  = f"{filename_prefix}_{base_name}" if filename_prefix else base_name
        filepath  = _unique_path(save_dir, filename)

        image.save(filepath, format="PNG")
        print(f"  [📸 {index}] 클립보드 캡처 저장 → {filepath}")
        return True, filepath

    except Exception as e:
        print(f"  [❌ {index}] ImageGrab 오류: {e}")
        return False, None

# ──────────────────────────────────────────────
# 핵심 기능 4 : 전체 파이프라인 실행
# ──────────────────────────────────────────────
def _download_images(
    html                : str,
    base_url            : str   = "",
    save_dir            : str   = DEFAULT_SAVE_DIR,
    grab_delay          : float = 0.3,
    filename_prefix     : str   = "",
    browser_download_fn         = None,
) -> dict:
    """
    HTML에서 이미지를 추출하고, 다운로드 실패 시 클립보드 캡처로 폴백합니다.

    Parameters
    ----------
    html       : 클립보드 HTML 문자열
    base_url   : 상대 경로 변환용 기준 URL
    save_dir   : 이미지 저장 폴더 경로
    grab_delay : ImageGrab 호출 전 대기 시간(초) - UI 안정화용

    Returns
    -------
    {
        "total"    : int,
        "success"  : int,
        "failed"   : int,
        "skipped"  : int,
        "saved_files": [Path, ...]
    }
    """
    save_path   = _ensure_dir(save_dir)
    img_list    = extract_img_urls(html, base_url)

    stats = {
        "total"      : len(img_list),
        "success"    : 0,
        "failed"     : 0,
        "skipped"    : 0,
        "saved_files": [],
    }

    if not img_list:
        print("⚠️  처리할 이미지가 없습니다.")
        return stats

    print("=" * 55)
    print(f"📥 이미지 다운로드 시작 (저장 위치: {save_path.resolve()})")
    print("=" * 55)

    for item in img_list:
        idx = item["index"]
        src = item["src"]
        print(f"\n[{idx}/{stats['total']}] 처리 중: {src[:60]}...")

        # ── data URI는 이미 인라인 임베드된 이미지 → 건너뜀 (실패 아님) ──
        if src.startswith("data:"):
            stats["skipped"] += 1
            print(f"  [⏭️  {idx}] data URI (이미 임베드됨) → 건너뜀")
            continue

        # ── Step 1: 브라우저 또는 requests로 다운로드 ──
        ok, filepath = download_image(src, idx, save_path, filename_prefix, browser_download_fn)

        # ── Step 2: 실패 시 ImageGrab 폴백 ──
        if not ok:
            print(f"  [🔄 {idx}] 다운로드 실패 → 클립보드 캡처 시도...")
            time.sleep(grab_delay)
            ok, filepath = grab_clipboard_image(idx, save_path, filename_prefix)

        # ── 결과 집계 ──
        if ok and filepath:
            stats["success"]     += 1
            stats["saved_files"].append(filepath)
        else:
            stats["failed"] += 1
            print(f"  [💀 {idx}] 최종 실패 → 건너뜀")

    # ── 최종 요약 ──
    print("\n" + "=" * 55)
    print("📊 처리 완료 요약")
    print("=" * 55)
    print(f"  전체 이미지  : {stats['total']}개")
    print(f"  ✅ 성공      : {stats['success']}개")
    print(f"  ❌ 실패      : {stats['failed']}개")
    print(f"  ⏭️  건너뜀    : {stats['skipped']}개 (data URI 인라인 이미지)")
    print(f"  📁 저장 위치 : {save_path.resolve()}")
    print("=" * 55)

    return stats

def process_html_images(
    html                : str,
    base_url            : str   = "",
    save_dir            : str   = DEFAULT_SAVE_DIR,
    grab_delay          : float = 0.3,
    run_id              : str   = "",
    replace_path        : bool  = True,
    output_html         : str   = "./output.html",
    convert_md          : bool  = True,
    output_md           : str   = "./output.md",
    browser_download_fn         = None,
) -> dict:

    stats = _download_images(
        html, base_url, save_dir, grab_delay,
        filename_prefix=run_id,
        browser_download_fn=browser_download_fn,
    )

    # ── Step 1: 경로 치환 (이미지가 있을 때만) ──
    if replace_path and stats["saved_files"]:
        replaced_html, replace_report = replace_all_image_paths(
            html         = html,
            saved_files  = stats["saved_files"],
            base_url     = base_url,
            local_prefix = "./assets/",
            save_output  = True,
            output_path  = output_html,
        )
        stats["replaced_html"]  = replaced_html
        stats["output_html"]    = output_html
        stats["replace_report"] = replace_report
    else:
        # 이미지가 없어도 원본 HTML 저장
        Path(output_html).write_text(html, encoding="utf-8")
        stats["replaced_html"] = html
        stats["output_html"]   = output_html
        print(f"  ℹ️  이미지 없음 → 원본 HTML 저장: {output_html}")

    # ── Step 2: Markdown 변환 ──
    if convert_md:
        md_text, md_path = run_md_pipeline(
            html   = stats["replaced_html"],
            output = output_md,
        )
        stats["md_text"]   = md_text
        stats["output_md"] = str(md_path)

    return stats