import re
from pathlib import Path
from urllib.parse import urlparse, urljoin

from bs4 import BeautifulSoup, Tag

# ──────────────────────────────────────────────
# 유틸리티
# ──────────────────────────────────────────────
def _normalize_src(src: str, base_url: str = "") -> str:
    """
    상대 경로 src를 절대 URL로 정규화.
    이미 절대 경로거나 data URI면 그대로 반환.
    """
    src = src.strip()
    if not src or src.startswith("data:"):
        return src
    if base_url and not src.startswith(("http://", "https://")):
        return urljoin(base_url, src)
    return src

def _match_saved_file(src: str, saved_files: list[Path]) -> Path | None:
    """
    원본 src URL과 저장된 로컬 파일명을 매칭합니다.

    매칭 우선순위:
      1. URL의 파일명과 로컬 파일명이 완전히 일치
      2. URL의 파일명이 로컬 파일명에 포함 (넘버링 suffix 대응)
      3. 인덱스 기반 파일명 패턴 (img_001.png, clipboard_img_001.png)
    """
    if not src or src.startswith("data:"):
        return None

    url_filename = Path(urlparse(src).path).name.strip()

    for filepath in saved_files:
        local_name = filepath.name

        # ── 우선순위 1: 완전 일치 ──
        if url_filename and url_filename == local_name:
            return filepath

        # ── 우선순위 2: 부분 일치 (넘버링 suffix 대응) ──
        if url_filename and url_filename in local_name:
            return filepath

    return None

# ──────────────────────────────────────────────
# 핵심 기능 1 : BeautifulSoup 기반 정밀 치환
# ──────────────────────────────────────────────
def replace_img_src_with_soup(
    html       : str,
    saved_files: list[Path],
    base_url   : str = "",
    local_prefix: str = "./assets/",
) -> tuple[str, dict]:
    """
    BeautifulSoup으로 HTML을 파싱하여 <img> 태그의 src를
    로컬 경로로 정밀하게 치환합니다.

    Parameters
    ----------
    html         : 원본 HTML 문자열
    saved_files  : 다운로드/캡처된 로컬 파일 Path 목록
    base_url     : 상대 경로 정규화용 기준 URL
    local_prefix : 로컬 경로 접두사 (기본: ./assets/)

    Returns
    -------
    (치환된 HTML 문자열, 치환 결과 리포트 dict)
    """
    soup     = BeautifulSoup(html, "html.parser")
    img_tags = soup.find_all("img")

    report = {
        "total"   : len(img_tags),
        "replaced": 0,
        "skipped" : 0,
        "details" : [],   # {"original": str, "replaced": str, "status": str}
    }

    # 인덱스 기반 매칭을 위한 순서 추적
    indexed_files = list(saved_files)  # 순서 보존

    for order, tag in enumerate(img_tags, start=1):
        # lazy-load 속성 우선 탐색
        src_attr = None
        for attr in ("src", "data-src", "data-original"):
            if tag.get(attr):
                src_attr = attr
                break

        if not src_attr:
            report["skipped"] += 1
            report["details"].append({
                "index"   : order,
                "original": "(src 없음)",
                "replaced": None,
                "status"  : "⏭️  src 속성 없음",
            })
            continue

        original_src = tag[src_attr].strip()
        normalized   = _normalize_src(original_src, base_url)

        # ── data URI는 치환 대상에서 제외 ──
        if normalized.startswith("data:"):
            report["skipped"] += 1
            report["details"].append({
                "index"   : order,
                "original": original_src[:60] + "...",
                "replaced": None,
                "status"  : "⏭️  data URI 건너뜀",
            })
            continue

        # ── 파일명 기반 매칭 시도 ──
        matched = _match_saved_file(normalized, indexed_files)

        # ── 파일명 매칭 실패 시 순서(index) 기반 매칭 ──
        if not matched and (order - 1) < len(indexed_files):
            matched = indexed_files[order - 1]

        if matched:
            local_path = local_prefix + matched.name
            tag[src_attr] = local_path

            # srcset 속성도 함께 제거 (로컬 환경에서 불필요)
            if tag.get("srcset"):
                del tag["srcset"]

            report["replaced"] += 1
            report["details"].append({
                "index"   : order,
                "original": original_src,
                "replaced": local_path,
                "status"  : "✅ 치환 완료",
            })
            print(f"  [✅ {order}] {original_src[:50]:.<55} → {local_path}")
        else:
            report["skipped"] += 1
            report["details"].append({
                "index"   : order,
                "original": original_src,
                "replaced": None,
                "status"  : "❌ 매칭 실패",
            })
            print(f"  [❌ {order}] 매칭 실패: {original_src[:60]}")

    return str(soup), report

# ──────────────────────────────────────────────
# 핵심 기능 2 : 정규식 기반 보조 치환
# (soup 파싱이 불완전한 인라인 스타일 background-image 대응)
# ──────────────────────────────────────────────
def replace_background_images(
    html        : str,
    saved_files : list[Path],
    local_prefix: str = "./assets/",
) -> str:
    """
    인라인 스타일의 background-image: url(...) 패턴도 치환합니다.

    예) style="background-image: url('https://example.com/bg.jpg')"
         →    style="background-image: url('./assets/bg.jpg')"
    """
    # url('...') 또는 url("...") 또는 url(...) 패턴 모두 대응
    pattern = re.compile(
        r'url\(\s*["\']?(https?://[^"\')\s]+)["\']?\s*\)',
        re.IGNORECASE,
    )

    def _replacer(match: re.Match) -> str:
        original_url = match.group(1)
        matched_file = _match_saved_file(original_url, saved_files)
        if matched_file:
            local_path = local_prefix + matched_file.name
            print(f"  [🎨 BG] {original_url[:50]:.<55} → {local_path}")
            return f"url('{local_path}')"
        return match.group(0)  # 매칭 실패 시 원본 유지

    return pattern.sub(_replacer, html)

# ──────────────────────────────────────────────
# 핵심 기능 3 : HTML 파일로 저장
# ──────────────────────────────────────────────
def save_html(
    html     : str,
    output   : str = "./output.html",
    encoding : str = "utf-8",
) -> Path:
    """
    치환된 HTML을 파일로 저장합니다.

    Parameters
    ----------
    html     : 저장할 HTML 문자열
    output   : 저장 경로 (기본: ./output.html)
    encoding : 파일 인코딩 (기본: utf-8)

    Returns
    -------
    저장된 파일의 Path 객체
    """
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding=encoding) as f:
        f.write(html)

    print(f"\n  [💾] HTML 저장 완료 → {output_path.resolve()}")
    return output_path

# ──────────────────────────────────────────────
# 핵심 기능 4 : 전체 치환 파이프라인
# ──────────────────────────────────────────────
def replace_all_image_paths(
    html        : str,
    saved_files : list[Path],
    base_url    : str  = "",
    local_prefix: str  = "./assets/",
    save_output : bool = True,
    output_path : str  = "./output.html",
) -> tuple[str, dict]:
    """
    <img src>, data-src, background-image 를 모두 로컬 경로로 치환하고
    선택적으로 HTML 파일로 저장합니다.

    Parameters
    ----------
    html         : 원본 HTML 문자열
    saved_files  : 다운로드된 로컬 파일 Path 목록
    base_url     : 상대 경로 정규화 기준 URL
    local_prefix : 로컬 경로 접두사
    save_output  : True면 output.html로 저장
    output_path  : 저장할 HTML 파일 경로

    Returns
    -------
    (치환된 HTML 문자열, 치환 리포트 dict)
    """
    print("\n" + "=" * 55)
    print("🔄 이미지 경로 치환 시작")
    print("=" * 55)

    # ── Step 1: <img> 태그 src 치환 ──
    print("\n📌 [Step 1] <img> 태그 src 치환 중...")
    replaced_html, report = replace_img_src_with_soup(
        html, saved_files, base_url, local_prefix
    )

    # ── Step 2: background-image 치환 ──
    print("\n📌 [Step 2] background-image 스타일 치환 중...")
    replaced_html = replace_background_images(
        replaced_html, saved_files, local_prefix
    )

    # ── Step 3: HTML 파일 저장 ──
    if save_output:
        print("\n📌 [Step 3] HTML 파일 저장 중...")
        save_html(replaced_html, output_path)

    # ── 최종 리포트 출력 ──
    print("\n" + "=" * 55)
    print("📊 치환 결과 요약")
    print("=" * 55)
    print(f"  전체 <img> 태그 : {report['total']}개")
    print(f"  ✅ 치환 성공    : {report['replaced']}개")
    print(f"  ⏭️  건너뜀      : {report['skipped']}개")
    print("=" * 55)

    # 상세 리포트
    print("\n📋 상세 치환 내역:")
    for detail in report["details"]:
        status = detail["status"]
        orig   = detail["original"][:45]
        repl   = detail["replaced"] or "N/A"
        print(f"  [{detail['index']:>2}] {status} | {orig:<45} → {repl}")

    return replaced_html, report