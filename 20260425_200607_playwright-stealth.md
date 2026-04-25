# Playwright 자동화 감지 우회 방법

구글 Gemini 등 자동화 브라우저를 차단하는 사이트에서 Playwright를 정상적으로 사용하기 위한 설정.

## 문제

Playwright는 기본적으로 세 가지 자동화 신호를 브라우저에 심는다.

| 신호 | 설명 |
|------|------|
| `--enable-automation` | Playwright가 기본으로 추가하는 플래그 → "자동화된 테스트 소프트웨어에 의해 제어되고 있습니다" 배너 표시 |
| `--enable-blink-features=AutomationControlled` | Blink 엔진 자동화 모드 활성화 |
| `navigator.webdriver` | JS에서 감지 가능한 자동화 프로퍼티 (`true`로 설정됨) |

번들 Chromium은 실제 Chrome/Edge와 달리 자동화 브라우저로 식별될 가능성이 높다.

## 해결책

### 1. 실제 설치된 브라우저 사용 (폴백 포함)

```python
for channel in ["msedge", "chrome", None]:
    try:
        kwargs = {"channel": channel} if channel else {}
        _browser_context = await _playwright.chromium.launch_persistent_context(
            ...
            **kwargs,
        )
        break
    except Exception:
        continue
```

- `msedge` → `chrome` → 번들 Chromium 순으로 자동 폴백
- Windows에는 Edge가 기본 설치되어 있어 대부분 첫 번째에서 성공

### 2. 자동화 플래그 제거

```python
args=["--start-maximized", "--disable-blink-features=AutomationControlled"],
ignore_default_args=["--enable-automation"],  # 핵심: Playwright 기본 플래그 제거
```

- `ignore_default_args`로 Playwright가 자동 추가하는 `--enable-automation`을 제거
- `--disable-blink-features=AutomationControlled`로 Blink 자동화 모드 비활성화

### 3. navigator.webdriver 숨기기

```python
await _browser_context.add_init_script(
    "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
)
```

- 모든 페이지 로드 전에 실행되어 JS 레벨의 자동화 감지 차단

## 최종 코드

```python
_playwright = await async_playwright().start()
for channel in ["msedge", "chrome", None]:
    try:
        kwargs = {"channel": channel} if channel else {}
        _browser_context = await _playwright.chromium.launch_persistent_context(
            user_data_dir=str(BASE_DIR / ".browser_profile"),
            headless=False,
            no_viewport=True,
            args=["--start-maximized", "--disable-blink-features=AutomationControlled"],
            ignore_default_args=["--enable-automation"],
            **kwargs,
        )
        await _browser_context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        break
    except Exception:
        continue
```

## 플랫폼별 동작

| 플랫폼 | 사용되는 브라우저 |
|--------|----------------|
| Windows | Edge (기본 설치) |
| macOS / Linux | Chrome (설치된 경우) → 번들 Chromium |
