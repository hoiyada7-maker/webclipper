import asyncio
import os
import sys
from pathlib import Path
from PIL import Image

# main.py 로직 직접 호출
from main import _run_manual_extract, OUTPUT_DIR, ASSETS_DIR

async def main():
    filename = "2026-04-17 165701 추천.md"
    
    # 1. 파일에서 이미지 찾기
    file_path = OUTPUT_DIR / filename
    content = file_path.read_text(encoding="utf-8")
    import re
    import urllib.parse
    pattern = re.compile(r'!\[.*?\]\((.*?)\)')
    image_paths = pattern.findall(content)
    
    abs_images = []
    for p in image_paths:
        if p.startswith("data:") or p.startswith("http"): continue
        decoded = urllib.parse.unquote(p)
        abs_p = (OUTPUT_DIR / decoded).resolve()
        if abs_p.exists():
            abs_images.append(str(abs_p))
            
    boxes = {}
    
    for img_path_str in abs_images:
        try:
            with Image.open(img_path_str) as img:
                w, h = img.size
                boxes[img_path_str] = [
                    {"x": 0, "y": 0, "w": w, "h": h, "type": "figure"}
                ]
        except Exception as e:
            print(f"Error reading image {img_path_str}: {e}")
            
    print(f"Executing manual extract for {filename} with full image boxes...")
    print(f"Boxes: {boxes}")
    await _run_manual_extract(filename, boxes)
    print("Execution completed.")

if __name__ == "__main__":
    asyncio.run(main())
