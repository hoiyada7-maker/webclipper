import asyncio
import os
import sys

# main.py의 로직을 직접 테스트하기 위해
from main import _run_manual_extract, OUTPUT_DIR, ASSETS_DIR

async def main():
    filename = "2026-04-17 165701 추천.md"
    
    # 하드코딩된 이미지 경로 (output/assets 내 파일)
    img1 = "2026-04-17 165701 추천_kgon1755606228_1477744679.jpg"
    img2 = "2026-04-17 165701 추천_kgon1755606229_1986138787.jpg"
    
    img1_path = str(ASSETS_DIR / img1)
    img2_path = str(ASSETS_DIR / img2)
    
    # 임의의 좌표로 박스 생성
    boxes = {
        img1_path: [
            {"x": 10, "y": 10, "w": 300, "h": 50, "type": "text"},
            {"x": 10, "y": 100, "w": 400, "h": 300, "type": "figure"}
        ],
        img2_path: [
            {"x": 20, "y": 20, "w": 200, "h": 50, "type": "text"}
        ]
    }
    
    print(f"Executing manual extract for {filename}...")
    await _run_manual_extract(filename, boxes)
    print("Execution completed.")

if __name__ == "__main__":
    asyncio.run(main())
