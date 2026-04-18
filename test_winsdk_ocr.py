import asyncio
from pathlib import Path

import winsdk.windows.media.ocr as win_ocr
import winsdk.windows.globalization as glob
import winsdk.windows.graphics.imaging as imaging
import winsdk.windows.storage as storage

IMG_PATH = r"C:\Users\su\pjt\webclipper-main\output\assets\2026-04-17 165701 추천_txt_20260418_215015_0.png"

async def run():
    lang = glob.Language("ko-KR")
    if not win_ocr.OcrEngine.is_language_supported(lang):
        print("❌ ko-KR 언어팩 미설치. Windows 설정 > 언어 > 한국어 OCR 팩 설치 필요")
        return

    engine = win_ocr.OcrEngine.try_create_from_language(lang)

    file = await storage.StorageFile.get_file_from_path_async(IMG_PATH)
    stream = await file.open_async(storage.FileAccessMode.READ)
    decoder = await imaging.BitmapDecoder.create_async(stream)
    bitmap = await decoder.get_software_bitmap_async()

    result = await engine.recognize_async(bitmap)

    lines = [line.text for line in result.lines]
    output = "\n".join(lines)
    print(output)
    with open("ocr_result_winsdk.txt", "w", encoding="utf-8") as f:
        f.write(output + "\n")

asyncio.run(run())
