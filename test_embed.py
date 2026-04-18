"""
Playwright E2E 테스트: MD 파일 드래그앤드롭 → Base64 임베드 → 다운로드 검증
"""
import time
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

SERVER_URL = "http://127.0.0.1:8000"
MD_FILE    = Path("/home/su/project/output/2026-04-14 092154 Setting up I.md")
DL_DIR     = Path("/tmp/embed_test_downloads")


def run_test():
    DL_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            "",
            headless=False,
            args=["--no-sandbox"],
            accept_downloads=True,
        )
        page = context.new_page()

        # ── 1. 서버 접속 ──
        print("[1/6] 서버 접속...")
        page.goto(SERVER_URL)
        page.wait_for_load_state("networkidle")
        assert "HTML Image Processor" in page.title()
        print("      ✅ 접속 성공")

        # ── 2. 좌측 탭 확인 (Pipeline / Embed MD) ──
        print("[2/6] 좌측 탭 구조 확인...")
        tabs = page.locator(".left-tab")
        assert tabs.count() == 2, f"탭 수 오류: {tabs.count()}"
        tab_texts = [tabs.nth(i).text_content() for i in range(2)]
        print(f"      탭: {tab_texts}")
        assert any("파이프라인" in t for t in tab_texts), "파이프라인 탭 없음"
        assert any("임베드" in t    for t in tab_texts), "임베드 탭 없음"
        print("      ✅ 탭 구조 정상")

        # ── 3. Embed MD 탭 클릭 ──
        print("[3/6] Embed MD 탭 클릭...")
        page.locator(".left-tab", has_text="임베드").click()
        page.wait_for_selector("#ltab-embed.active", timeout=2000)
        assert page.is_visible("#embedDropZone"), "드롭존 미표시"
        print("      ✅ Embed 탭 정상 표시")

        # ── 4. 파일 선택 (input[type=file]) ──
        print("[4/6] MD 파일 선택...")
        assert MD_FILE.exists(), f"테스트 파일 없음: {MD_FILE}"
        page.locator("#embedFileInput").set_input_files(str(MD_FILE))

        # 처리 완료 대기 (서버에서 42개 이미지 처리 → 수 초 소요)
        page.wait_for_selector("#embedStatus.status--success", timeout=30000)
        status_text = page.text_content("#embedStatus")
        print(f"      상태: {status_text}")
        assert "완료" in status_text, f"완료 메시지 없음: {status_text}"
        assert "이미지" in status_text and "임베드" in status_text
        print("      ✅ 임베드 완료")

        # ── 5. 다운로드 버튼 확인 ──
        print("[5/6] 다운로드 버튼 확인...")
        dl_btn = page.locator("#btnDownloadEmbedded")
        assert dl_btn.is_visible(), "다운로드 버튼 미표시"
        href = dl_btn.get_attribute("href")
        assert href and "/api/download" in href, f"href 오류: {href}"
        filename_param = href.split("path=")[-1]
        import urllib.parse
        embedded_filename = urllib.parse.unquote(filename_param)
        print(f"      다운로드 파일명: {embedded_filename}")
        print("      ✅ 다운로드 버튼 정상")

        # ── 6. 실제 다운로드 실행 ──
        print("[6/6] 실제 다운로드 실행...")
        with page.expect_download(timeout=30000) as dl_info:
            dl_btn.click()
        download = dl_info.value

        saved_path = DL_DIR / download.suggested_filename
        download.save_as(str(saved_path))
        print(f"      저장 위치: {saved_path}")

        assert saved_path.exists(), "다운로드 파일 없음"
        size = saved_path.stat().st_size
        assert size > 100_000, f"파일 크기가 너무 작음: {size} bytes"
        print(f"      파일 크기: {size:,} bytes")

        # Base64 이미지 임베드 확인
        content = saved_path.read_text(encoding="utf-8")
        img_count = content.count("data:image/")
        assert img_count > 0, "Base64 이미지 없음"
        assert "![" in content and "data:image/png;base64," in content
        print(f"      ✅ Base64 이미지 {img_count}개 포함 확인")

        # 원본 경로(./assets/)가 남아있지 않은지 확인
        assert "./assets/" not in content, "원본 경로가 남아있음 (치환 실패)"
        print("      ✅ 원본 경로 완전 제거 확인")

        context.close()
        return True


if __name__ == "__main__":
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        print(f"\n{'='*55}")
        print(f"테스트 #{attempt}/{max_attempts}")
        print(f"{'='*55}")
        try:
            if run_test():
                print("\n✅✅✅ 모든 테스트 통과! ✅✅✅")
                break
        except Exception as e:
            import traceback
            print(f"\n❌ 실패: {e}")
            traceback.print_exc()
            if attempt < max_attempts:
                print("3초 후 재시도...")
                time.sleep(3)
            else:
                raise
