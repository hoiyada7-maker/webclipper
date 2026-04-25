# 캡처도구 OCR 분석 방법론

"캡처도구와 동일한 엔진 → word 단위"라는 결론에 도달하기까지의 추론 과정.

---

## 출발점: 문제 현상

```
Windows OCR API로 뽑은 박스  →  너무 넓음, 글자 아닌 영역까지 포함
캡처도구 텍스트 복사 결과     →  훨씬 타이트하고 정확함
```

**가설**: 캡처도구는 다른 엔진을 쓴다.

---

## 분석 1 — "캡처도구가 뭘 쓰는지" 좁히기

### 질문 순서

1. **캡처도구는 OS 내장 앱인가, 독립 ML 모델인가?**  
   → Windows 스토어 앱이지만 OS 깊숙이 통합되어 있음.  
   → 인터넷 연결 없이도 동작 → 클라우드 API 아님.  
   → 설치 용량이 작음 → 대형 ML 모델 번들 아님.  
   → **결론: OS 내장 API 호출 가능성 높음.**

2. **Windows에 내장된 OCR API가 있는가?**  
   → 있음: `Windows.Media.Ocr.OcrEngine` (WinRT, Windows 10부터 내장)  
   → 이것이 Windows에서 텍스트 인식에 쓸 수 있는 사실상 유일한 OS 내장 API.  
   → **결론: 캡처도구도 이걸 쓸 가능성이 매우 높음.**

3. **우리가 이미 winsdk로 쓰던 API와 같은가?**  
   → `winsdk`는 Python에서 WinRT를 래핑한 패키지.  
   → 우리가 쓰던 `winsdk.windows.media.ocr.OcrEngine` = `Windows.Media.Ocr.OcrEngine`  
   → **결론: 엔진 자체는 동일.**

---

## 분석 2 — 그렇다면 왜 결과가 달랐나

엔진이 같은데 결과가 다르다 → **입력 또는 출력 처리 방식이 다를 것.**

### OcrEngine API 구조 재확인

```
OcrResult
  └─ Lines[]           ← 우리가 쓰던 단위
         └─ Words[]    ← 각 줄 안의 단어들, 각자 BoundingRect 보유
```

API에는 두 단계가 있었는데, 우리는 **Line 단위**만 봤음.

### 캡처도구 화면 행동 관찰

캡처도구의 텍스트 복사 결과를 관찰하면:
- 단어 하나하나를 개별 선택할 수 있음 (더블클릭 동작)
- 줄 단위가 아니라 **단어 단위**로 경계가 그려짐

→ **결론: 캡처도구는 `Words[]` 순회, 우리는 `Lines[]`만 봤던 것.**

---

## 분석 3 — 검증

| 조건 | 예상 | 근거 |
|------|------|------|
| Line bbox | 넓음 | 한 줄 전체를 감싸는 직사각형 |
| Word bbox | 좁음 | 단어 하나씩 감싸는 직사각형 |
| Line 병합 | 더 넓음 | 여러 줄 union → 최악 |

이전 코드가 "line merging"까지 했으니 가장 넓은 박스가 나온 것.  
Word 단위로 바꾸면 캡처도구와 동일한 granularity.

---

## 핵심 추론 패턴 (재사용 가능)

```
앱이 어떤 기능을 제공하는가
        ↓
그 기능을 OS/플랫폼이 API로 제공하는가?  →  YES → 그 API를 직접 써라
        ↓ NO
외부 라이브러리인가 / 자체 ML인가?
        ↓
오프라인 동작 여부, 설치 용량, 반응 속도로 판단
```

### Windows 앱 분석 시 참고

- **인터넷 없이 동작** + **설치 용량 작음** → OS 내장 WinRT API 사용 의심
- Windows 10/11에서 OCR 관련 API: `Windows.Media.Ocr`
- Windows 10/11에서 음성 관련 API: `Windows.Media.SpeechRecognition`
- Windows 10/11에서 이미지 분석: `Windows.Media.FaceAnalysis`, `Windows.AI.MachineLearning`
- Python 접근: `winsdk` 패키지

### 동작 차이 원인 찾는 법

1. **API 구조를 다시 읽는다** — 우리가 쓰는 레벨보다 세밀한 레벨이 있는지 확인
2. **앱의 UI 동작을 관찰한다** — 선택 단위, 하이라이트 단위가 API granularity를 반영함
3. **"같은 엔진인데 결과가 다르다"면** → 입력 전처리 or 출력 레벨 차이
