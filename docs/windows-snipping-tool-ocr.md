# Windows 캡처도구(Snipping Tool) OCR 내부 동작 분석

## 핵심 결론

캡처도구의 "텍스트 복사" 기능은 **Windows.Media.Ocr.OcrEngine** (WinRT API)을 사용한다.
Python에서 `winsdk` 패키지로 동일한 엔진에 직접 접근 가능하다.

---

## 아키텍처

```
캡처도구 UI
    │
    ▼
Windows.Media.Ocr.OcrEngine  ← WinRT API (운영체제 내장)
    │
    ├─ OcrEngine.RecognizeAsync(SoftwareBitmap)
    │       │
    │       └─ OcrResult
    │               ├─ Lines[]          ← 줄 단위
    │               │      └─ Words[]   ← 단어 단위 (BoundingRect 포함)
    │               └─ Text            ← 전체 인식 텍스트
    │
    └─ 지원 언어: Windows 설정에 설치된 OCR 언어팩
```

---

## 캡처도구와 raw API의 차이

| 항목 | 캡처도구 | raw OcrEngine (API 직접 호출) |
|------|---------|-------------------------------|
| 단위 | Word 단위 bbox | Line 단위 또는 Word 단위 (선택 가능) |
| 다국어 | 자동 감지 | 언어 명시 필요 |
| 이전에 박스가 넓었던 이유 | — | **Line 단위**로 뽑아서 합쳤기 때문 |
| 해결법 | — | `line.words` 순회 → word 단위 bbox 사용 |

---

## Python 구현 (winsdk)

### 설치

```bash
pip install winsdk
```

### 핵심 코드

```python
import asyncio
import winsdk.windows.media.ocr as win_ocr
import winsdk.windows.globalization as glob
import winsdk.windows.graphics.imaging as imaging
import winsdk.windows.storage as storage

async def ocr_word_boxes(img_path: str) -> list[dict]:
    """
    이미지에서 word 단위 bbox 추출.
    캡처도구와 동일한 엔진 사용.
    img_path: 절대 경로 PNG/JPG (winsdk는 절대경로 필요)
    반환: [{"x", "y", "w", "h"}, ...]
    """
    boxes = []
    for lang_tag in ("ko-KR", "en-US"):
        lang = glob.Language(lang_tag)
        if not win_ocr.OcrEngine.is_language_supported(lang):
            continue
        engine  = win_ocr.OcrEngine.try_create_from_language(lang)
        file    = await storage.StorageFile.get_file_from_path_async(img_path)
        stream  = await file.open_async(storage.FileAccessMode.READ)
        decoder = await imaging.BitmapDecoder.create_async(stream)
        bitmap  = await decoder.get_software_bitmap_async()
        result  = await engine.recognize_async(bitmap)

        for line in result.lines:
            for word in line.words:          # ← word 단위가 핵심
                r = word.bounding_rect
                boxes.append({
                    "x": int(r.x), "y": int(r.y),
                    "w": int(r.width), "h": int(r.height),
                    "text": word.text,       # 인식된 텍스트 (선택)
                })
    return boxes

# 실행
boxes = asyncio.run(ocr_word_boxes(r"C:\path\to\image.png"))
```

### 텍스트만 추출할 때

```python
async def ocr_text(img_path: str, lang_tag="ko-KR") -> str:
    lang    = glob.Language(lang_tag)
    engine  = win_ocr.OcrEngine.try_create_from_language(lang)
    file    = await storage.StorageFile.get_file_from_path_async(img_path)
    stream  = await file.open_async(storage.FileAccessMode.READ)
    decoder = await imaging.BitmapDecoder.create_async(stream)
    bitmap  = await decoder.get_software_bitmap_async()
    result  = await engine.recognize_async(bitmap)
    return "\n".join(line.text for line in result.lines)
```

---

## 주의사항

### 한글 경로 이미지
`StorageFile.get_file_from_path_async`는 한글 경로를 지원하지만,  
임시 PNG로 저장 후 넘기는 방식이 더 안전하다.

```python
import cv2, tempfile, os, numpy as np

# 한글 경로 이미지 → BGR array
img_array = np.fromfile(korean_path, np.uint8)
img_bgr   = cv2.imdecode(img_array, cv2.IMREAD_COLOR)

# 임시 PNG 저장 → OCR
with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
    tmp = tf.name
cv2.imwrite(tmp, img_bgr)
try:
    boxes = asyncio.run(ocr_word_boxes(tmp))
finally:
    os.unlink(tmp)
```

### FastAPI 비동기 환경
FastAPI endpoint 안에서 호출할 때:

```python
@app.post("/api/ocr")
async def ocr_endpoint(request: Request):
    # await로 직접 호출 가능 (이미 async 함수)
    boxes = await ocr_word_boxes(img_path)
    return {"boxes": boxes}
```

### 언어팩 미설치 시
`OcrEngine.is_language_supported(lang)` 로 먼저 확인.  
언어팩 설치: 윈도우 설정 → 시간 및 언어 → 언어 → 한국어 → 선택적 기능 → 기본 입력 → OCR

---

## 캡처도구 자동화 (클립보드 방식)

박스 위치 정보 없이 **텍스트만** 필요할 때 캡처도구를 직접 구동하는 방법.

```python
import subprocess, time, pyperclip

def snipping_tool_ocr_from_clipboard():
    """
    이미지를 클립보드에 복사한 뒤 캡처도구의 텍스트 추출 단축키 호출.
    반환값: 추출된 텍스트 (bbox 없음)
    """
    # Win+Shift+T = 캡처도구 텍스트 추출 모드
    subprocess.run(["powershell", "-Command",
        "[System.Windows.Forms.SendKeys]::SendWait('%{PRTSC}')"])
    time.sleep(1.5)
    return pyperclip.paste()
```

> **제한**: bbox(위치 정보) 없이 텍스트만 반환됨.  
> 위치 정보가 필요하면 반드시 `winsdk` 직접 호출 방식을 사용.

---

## 관련 WinRT API 레퍼런스

| API | 역할 |
|-----|------|
| `Windows.Media.Ocr.OcrEngine` | OCR 엔진 진입점 |
| `OcrEngine.try_create_from_language()` | 언어별 엔진 생성 |
| `OcrEngine.recognize_async(bitmap)` | 비동기 인식 실행 |
| `OcrResult.lines` | 줄 목록 |
| `OcrLine.words` | 단어 목록 (각 word에 `bounding_rect`, `text`) |
| `OcrWord.bounding_rect` | `{x, y, width, height}` 픽셀 좌표 |
| `Windows.Graphics.Imaging.BitmapDecoder` | 이미지 파일 → SoftwareBitmap 변환 |

---

## 요약

- 캡처도구 = `Windows.Media.Ocr.OcrEngine` + **word 단위 bbox** 표시
- Python에서 `winsdk`로 완전히 동일하게 구현 가능
- **line 단위**로 뽑으면 박스가 넓어짐 → 반드시 `line.words` 순회
- 한국어(`ko-KR`) + 영어(`en-US`) 두 번 돌리고 중복 제거하면 혼합 문서도 대응
