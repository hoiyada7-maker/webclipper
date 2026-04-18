import os
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

from paddleocr import PaddleOCR

img_path = r"C:\Users\su\pjt\webclipper-main\output\assets\2026-04-17 165701 추천_txt_20260418_215015_0.png"

ocr = PaddleOCR(use_angle_cls=True, lang="korean")
result = ocr.ocr(img_path, cls=True)

lines = []
for line in result[0]:
    bbox, (text, confidence) = line
    lines.append(f"[{confidence:.2f}] {text}")

output = "\n".join(lines)
print(output)

with open("ocr_result.txt", "w", encoding="utf-8") as f:
    f.write(output + "\n")
