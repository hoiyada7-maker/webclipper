import re
from pathlib import Path

from markdownify import markdownify as md, MarkdownConverter

# ──────────────────────────────────────────────
# 커스텀 MarkdownConverter 확장
# ──────────────────────────────────────────────
class WebClipperMarkdownConverter(MarkdownConverter):
    """
    markdownify 기본 변환기를 확장하여
    아래 항목들을 보완합니다.

      - <img>        : 로컬 경로 이미지를 ![alt](path) 형식으로 변환
      - <table>      : 헤더 없는 테이블도 정렬 처리
      - <br>         : 줄바꿈 보존
      - <del>/<s>    : 취소선 ~~ 변환
      - <mark>       : 하이라이트 == 변환 (Obsidian 호환)
      - 연속 공백/줄바꿈 : 정리
    """

    # ── <img> 처리 ──
    def convert_img(self, el, text, **kwargs):
        alt   = el.get("alt", "").strip()
        src   = (
            el.get("src") or
            el.get("data-src") or
            ""
        ).strip()
        title = el.get("title", "").strip()

        if not src:
            return ""

        # 공백이 포함된 경로는 Markdown 렌더러가 잘라내므로 %20으로 인코딩
        if " " in src and not src.startswith("data:"):
            from urllib.parse import quote
            parts = src.split("?", 1)
            parts[0] = quote(parts[0], safe="./:+#@!$&'()*+,;=-")
            src = "?".join(parts)

        title_part = f' "{title}"' if title else ""
        return f"![{alt}]({src}{title_part})"

    # ── <del>, <s> 취소선 처리 ──
    def convert_del(self, el, text, **kwargs):
        return f"~~{text.strip()}~~"

    convert_s = convert_del  # <s> 태그도 동일 처리

    # ── <mark> 하이라이트 처리 (Obsidian 호환) ──
    def convert_mark(self, el, text, **kwargs):
        return f"=={text.strip()}=="

    # ── <br> 줄바꿈 보존 ──
    def convert_br(self, el, text, **kwargs):
        return "  \n"

    # ── <table> 헤더 없는 경우 보완 ──
    def convert_table(self, el, text, **kwargs):
        """
        <thead>가 없는 테이블도 첫 번째 <tr>을 헤더로 간주하여
        Markdown 테이블 형식으로 변환합니다.
        """
        from bs4 import BeautifulSoup, Tag

        rows = el.find_all("tr")
        if not rows:
            return text

        def _parse_row(row) -> list[str]:
            cells = row.find_all(["td", "th"])
            return [c.get_text(strip=True).replace("|", "\\|") for c in cells]

        parsed_rows = [_parse_row(r) for r in rows]
        if not parsed_rows:
            return text

        # 열 수 통일
        col_count = max(len(r) for r in parsed_rows)
        for r in parsed_rows:
            while len(r) < col_count:
                r.append("")

        # 헤더 행
        header    = parsed_rows[0]
        separator = ["---"] * col_count
        body      = parsed_rows[1:]

        lines = []
        lines.append("| " + " | ".join(header) + " |")
        lines.append("| " + " | ".join(separator) + " |")
        for row in body:
            lines.append("| " + " | ".join(row) + " |")

        return "\n" + "\n".join(lines) + "\n\n"

# ──────────────────────────────────────────────
# 유틸리티 : Markdown 후처리
# ──────────────────────────────────────────────
def _post_process(md_text: str) -> str:
    """
    변환된 Markdown 텍스트를 정리합니다.

      1. 3줄 이상 연속 빈 줄 → 2줄로 축소
      2. 줄 끝 공백 제거
      3. 코드 블록 내부 들여쓰기 정리
      4. 링크/이미지 괄호 안 불필요한 공백 제거
      5. 파일 끝 개행 보장
    """
    # 1. 연속 빈 줄 정리 (3줄 이상 → 2줄)
    md_text = re.sub(r'\n{3,}', '\n\n', md_text)

    # 2. 줄 끝 공백 제거
    md_text = re.sub(r'[ \t]+$', '', md_text, flags=re.MULTILINE)

    # 3. 링크/이미지 괄호 안 공백 정리
    #    예) ![ alt ]( ./assets/img.png ) → ![alt](./assets/img.png)
    md_text = re.sub(r'!\[\s*(.*?)\s*\]\(\s*(.*?)\s*\)', r'![\1](\2)', md_text)
    md_text = re.sub(r'\[\s*(.*?)\s*\]\(\s*(.*?)\s*\)', r'[\1](\2)', md_text)

    # 4. 파일 끝 개행 보장
    md_text = md_text.strip() + "\n"

    return md_text

# ──────────────────────────────────────────────
# 핵심 기능 1 : HTML → Markdown 변환
# ──────────────────────────────────────────────
def convert_html_to_markdown(
    html             : str,
    heading_style    : str  = "ATX",          # ATX(#) or SETEXT(===)
    bullets          : str  = "-",            # 목록 기호: -, *, +
    code_language    : str  = "",             # 코드 블록 기본 언어
    strip_tags       : list = None,           # 제거할 태그 목록
    keep_inline_imgs : bool = True,           # 인라인 이미지 유지
) -> str:
    """
    WebClipperMarkdownConverter를 사용하여 HTML을 Markdown으로 변환합니다.

    Parameters
    ----------
    html              : 치환 완료된 HTML 문자열
    heading_style     : 제목 스타일 ('ATX' → #, 'SETEXT' → 밑줄)
    bullets           : 비순서 목록 기호
    code_language     : 펜스 코드 블록 기본 언어 힌트
    strip_tags        : 변환 시 완전히 제거할 HTML 태그 리스트
    keep_inline_imgs  : False면 이미지를 alt 텍스트로만 대체

    Returns
    -------
    후처리 완료된 Markdown 문자열
    """
    strip_tags = strip_tags or [
        "script", "style", "head",
        "meta", "link", "noscript",
        "iframe", "svg",
    ]

    converter = WebClipperMarkdownConverter(
        heading_style = heading_style,
        bullets       = bullets,
        code_language = code_language,
        strip         = strip_tags,
        convert       = None if keep_inline_imgs else ["p", "a", "b", "i"],
        newline_style = "backslash",
    )

    raw_md = converter.convert(html)
    return _post_process(raw_md)

# ──────────────────────────────────────────────
# 핵심 기능 2 : Markdown 파일 저장
# ──────────────────────────────────────────────
def save_markdown(
    md_text  : str,
    output   : str = "./output.md",
    encoding : str = "utf-8",
) -> Path:
    """
    변환된 Markdown 텍스트를 .md 파일로 저장합니다.

    Parameters
    ----------
    md_text  : 저장할 Markdown 문자열
    output   : 저장 경로 (기본: ./output.md)
    encoding : 파일 인코딩 (기본: utf-8)

    Returns
    -------
    저장된 파일의 Path 객체
    """
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding=encoding) as f:
        f.write(md_text)

    size_kb = output_path.stat().st_size / 1024
    print(f"  [💾] Markdown 저장 완료 → {output_path.resolve()} ({size_kb:.1f} KB)")
    return output_path

# ──────────────────────────────────────────────
# 핵심 기능 3 : HTML 파일에서 직접 변환
# ──────────────────────────────────────────────
def convert_html_file_to_markdown(
    html_path : str,
    output    : str  = "./output.md",
    encoding  : str  = "utf-8",
    **kwargs,
) -> tuple[str, Path]:
    """
    저장된 HTML 파일을 읽어 Markdown으로 변환 후 저장합니다.
    image_downloader → html_replacer 이후 output.html을 바로 처리할 때 사용.

    Parameters
    ----------
    html_path : 읽어올 HTML 파일 경로
    output    : 저장할 .md 파일 경로
    encoding  : 파일 인코딩
    **kwargs  : convert_html_to_markdown()에 전달할 추가 옵션

    Returns
    -------
    (변환된 Markdown 문자열, 저장된 파일 Path)
    """
    html_file = Path(html_path)
    if not html_file.exists():
        raise FileNotFoundError(f"HTML 파일을 찾을 수 없습니다: {html_file.resolve()}")

    print(f"\n  [📂] HTML 파일 읽는 중: {html_file.resolve()}")
    html = html_file.read_text(encoding=encoding)

    md_text     = convert_html_to_markdown(html, **kwargs)
    output_path = save_markdown(md_text, output, encoding)

    return md_text, output_path

# ──────────────────────────────────────────────
# 핵심 기능 4 : 전체 변환 파이프라인
# ──────────────────────────────────────────────
def run_md_pipeline(
    html        : str  = "",
    html_path   : str  = "",
    output      : str  = "./output.md",
    heading_style: str = "ATX",
    bullets     : str  = "-",
    **kwargs,
) -> tuple[str, Path]:
    """
    HTML 문자열 또는 HTML 파일 경로를 받아
    Markdown 변환 → 저장까지 전체 파이프라인을 실행합니다.

    html과 html_path 중 하나만 전달하면 됩니다.
    둘 다 전달된 경우 html 문자열이 우선합니다.

    Parameters
    ----------
    html         : HTML 문자열 (직접 전달 시)
    html_path    : HTML 파일 경로 (파일 기반 변환 시)
    output       : 저장할 .md 파일 경로
    heading_style: 제목 스타일
    bullets      : 목록 기호
    **kwargs     : convert_html_to_markdown()에 전달할 추가 옵션

    Returns
    -------
    (변환된 Markdown 문자열, 저장된 파일 Path)
    """
    print("\n" + "=" * 55)
    print("📝 HTML → Markdown 변환 파이프라인 시작")
    print("=" * 55)

    if not html and not html_path:
        raise ValueError("html 또는 html_path 중 하나는 반드시 전달해야 합니다.")

    if html:
        print("  [📋] HTML 문자열로부터 변환 시작...")
        md_text     = convert_html_to_markdown(
            html,
            heading_style = heading_style,
            bullets       = bullets,
            **kwargs,
        )
        output_path = save_markdown(md_text, output)
    else:
        print(f"  [📂] HTML 파일로부터 변환 시작: {html_path}")
        md_text, output_path = convert_html_file_to_markdown(
            html_path     = html_path,
            output        = output,
            heading_style = heading_style,
            bullets       = bullets,
            **kwargs,
        )

    # ── 변환 결과 미리보기 (첫 20줄) ──
    preview_lines = md_text.splitlines()[:20]
    print("\n  [👀] 변환 결과 미리보기 (최대 20줄):")
    print("  " + "─" * 50)
    for line in preview_lines:
        print(f"  {line}")
    if len(md_text.splitlines()) > 20:
        print(f"  ... (이하 {len(md_text.splitlines()) - 20}줄 생략)")
    print("  " + "─" * 50)

    print("\n" + "=" * 55)
    print("📊 변환 완료 요약")
    print("=" * 55)
    print(f"  📄 총 줄 수   : {len(md_text.splitlines()):,}줄")
    print(f"  🔤 총 글자 수 : {len(md_text):,}자")
    print(f"  💾 저장 위치  : {output_path.resolve()}")
    print("=" * 55)

    return md_text, output_path