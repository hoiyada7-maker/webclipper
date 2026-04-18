"""
Playwright E2E 테스트: 클립보드 읽기 → 이미지 다운로드 → 경로 치환 → Markdown 변환
"""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

SERVER_URL = "http://127.0.0.1:8000"

# 실제 다운로드 가능한 공개 이미지 URL 사용
SAMPLE_HTML = """<!DOCTYPE html>
<html><body>
  <h1>이미지 다운로드 테스트</h1>
  <p>아래 이미지들이 로컬로 다운로드되어야 합니다.</p>
  <img src="https://www.python.org/static/img/python-logo.png" alt="Python Logo" />
  <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/Docker_%28container_engine%29_logo.svg/200px-Docker_%28container_engine%29_logo.svg.png" alt="Docker" />
  <p>텍스트도 Markdown으로 변환되어야 합니다.</p>
</body></html>"""

def run_test():
    # 이전 아웃풋 초기화
    import shutil
    output_dir = Path("/home/su/project/output")
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)
    (output_dir / "assets").mkdir()

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            "",
            headless=False,
            args=["--no-sandbox"],
        )
        context.grant_permissions(["clipboard-read", "clipboard-write"])
        page = context.new_page()

        # ── 1. 서버 접속 ──
        print("[1/6] 서버 접속...")
        page.goto(SERVER_URL)
        page.wait_for_load_state("networkidle")
        assert "HTML Image Processor" in page.title()
        print("      ✅ 성공")

        # ── 2. 클립보드에 이미지 포함 HTML 쓰기 ──
        print("[2/6] 클립보드에 이미지 HTML 쓰기...")
        page.evaluate("""(html) => {
            const blob     = new Blob([html], { type: 'text/html' });
            const textBlob = new Blob([html], { type: 'text/plain' });
            return navigator.clipboard.write([
                new ClipboardItem({ 'text/html': blob, 'text/plain': textBlob })
            ]);
        }""", SAMPLE_HTML)
        print("      ✅ 성공")

        # ── 3. 읽기 버튼 클릭 ──
        print("[3/6] 읽기 버튼 클릭...")
        page.click("#btnReadClipboard")
        page.wait_for_selector(".status--success", timeout=5000)
        html_content = page.input_value("#htmlSource")
        assert "<img" in html_content, f"HTML에 img 태그 없음: {html_content[:200]}"
        print(f"      ✅ {len(html_content)} bytes, img 태그 포함")

        # ── 4. 파이프라인 실행 ──
        print("[4/6] 파이프라인 실행...")
        page.click("#btnProcess")
        page.wait_for_function(
            "document.querySelector('#logOutput').innerText.includes('처리 완료')",
            timeout=60000
        )
        log_text = page.text_content("#logOutput")
        print(f"      로그:\n{chr(10).join('        ' + l for l in log_text.strip().splitlines()[-15:])}")

        # 에러 확인
        assert "오류 발생" not in log_text, f"파이프라인 오류:\n{log_text}"
        assert "처리 완료" in log_text
        print("      ✅ 파이프라인 완료")

        # ── 5. 이미지 파일 확인 ──
        print("[5/6] 다운로드된 이미지 확인...")
        assets = list(Path("/home/su/project/output/assets").glob("*"))
        print(f"      assets/: {[f.name for f in assets]}")
        assert len(assets) > 0, "output/assets/ 폴더에 이미지 없음"
        for img in assets:
            assert img.stat().st_size > 0, f"{img.name} 파일이 비어있음"
        print(f"      ✅ {len(assets)}개 이미지 다운로드됨")

        # ── 6. 아웃풋 파일 확인 ──
        print("[6/6] output 파일 확인...")
        output_dir  = Path("/home/su/project/output")
        html_files  = sorted(output_dir.glob("*.html"))
        md_files    = sorted(output_dir.glob("*.md"))

        assert html_files, "output/*.html 없음"
        assert md_files,   "output/*.md 없음"

        output_html = html_files[-1]
        output_md   = md_files[-1]
        run_id      = output_html.stem

        assert output_html.stat().st_size > 0, f"{output_html.name} 비어있음"
        assert output_md.stat().st_size   > 0, f"{output_md.name} 비어있음"

        html_out = output_html.read_text(encoding="utf-8")
        md_out   = output_md.read_text(encoding="utf-8")

        # 이미지 파일명에 run_id 포함 확인
        assert any(run_id in f.name for f in assets), \
            f"이미지 파일명에 run_id 없음: {[f.name for f in assets]}"
        # 이미지 경로가 로컬 경로로 치환됐는지 확인
        assert "./assets/" in html_out, f"output.html에 로컬 경로 없음:\n{html_out[:500]}"
        assert "python.org" not in html_out, f"output.html에 원본 URL 남아있음"

        print(f"      ✅ {output_html.name} ({output_html.stat().st_size} bytes)")
        print(f"      ✅ {output_md.name}   ({output_md.stat().st_size} bytes)")
        print(f"\n--- output.md ---\n{md_out[:600]}")

        context.close()
        return True


if __name__ == "__main__":
    max_attempts = 5
    for attempt in range(1, max_attempts + 1):
        print(f"\n{'='*55}")
        print(f"테스트 #{attempt}/{max_attempts}")
        print(f"{'='*55}")
        try:
            if run_test():
                print("\n✅✅✅ 모든 테스트 통과! ✅✅✅")
                break
        except Exception as e:
            print(f"\n❌ 실패: {e}")
            if attempt < max_attempts:
                print("3초 후 재시도...")
                time.sleep(3)
            else:
                raise
