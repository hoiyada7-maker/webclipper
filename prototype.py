import cv2
import pytesseract
from PIL import Image
import os
import re

# Tesseract 경로 설정 (Windows 환경)
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

def parse_markdown_images(md_path):
    with open(md_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 정규식으로 이미지 링크 찾기 ![alt](path)
    image_pattern = re.compile(r'!\[.*?\]\((.*?)\)')
    image_paths = image_pattern.findall(content)
    
    import urllib.parse
    
    # md 파일의 위치를 기준으로 상대 경로 계산
    md_dir = os.path.dirname(md_path)
    abs_image_paths = []
    for path in image_paths:
        decoded_path = urllib.parse.unquote(path)
        abs_path = os.path.normpath(os.path.join(md_dir, decoded_path))
        abs_image_paths.append(abs_path)
    return abs_image_paths

def process_image_prototype(image_path, output_img_dir):
    if not os.path.exists(output_img_dir):
        os.makedirs(output_img_dir)
        
    import numpy as np
    
    # 한글 경로 지원을 위해 numpy와 imdecode 사용
    img_array = np.fromfile(image_path, np.uint8)
    image = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
    
    if image is None:
        print(f"이미지를 찾을 수 없습니다: {image_path}")
        return ""
        
    image_rgb = image[..., ::-1] # BGR to RGB
    
    # [프로토타입 검증용 임시 로직]
    # Detectron2/LayoutParser 설정이 복잡하므로, Tesseract의 image_to_data를 활용해 
    # 텍스트 블록과 여백/그림으로 간이 분리하는 프로토타입.
    
    # OCR로 텍스트 추출 (kor+eng)
    data = pytesseract.image_to_data(image_rgb, lang='kor+eng', output_type=pytesseract.Output.DICT)
    
    extracted_text = []
    for i in range(len(data['text'])):
        # 신뢰도(conf)가 일정 이상이고 텍스트가 존재하는 경우
        if int(data['conf'][i]) > 30 and data['text'][i].strip():
            extracted_text.append(data['text'][i].strip())
            
    # 전체 텍스트 병합
    full_text = " ".join(extracted_text)
    
    result_md = ""
    # 텍스트가 거의 없는 경우 (그림 위주로 판단)
    if len(full_text) < 10:
        base_name = os.path.basename(image_path)
        new_img_path = os.path.join(output_img_dir, f"fig_{base_name}")
        Image.fromarray(image_rgb).save(new_img_path)
        result_md += f"\n![Figure](./prototype_assets/fig_{base_name})\n\n"
    else:
        # 텍스트가 포함된 경우
        result_md += f"{full_text}\n\n"
        
    return result_md

def main():
    md_file = r"C:\Users\su\pjt\webclipper-main\output\2026-04-17 165701 추천.md"
    output_md = r"C:\Users\su\pjt\webclipper-main\output\prototype_result.md"
    output_img_dir = r"C:\Users\su\pjt\webclipper-main\output\prototype_assets"
    
    print("1. 마크다운 파일에서 이미지 경로 추출 중...")
    images = parse_markdown_images(md_file)
    print(f"  -> 총 {len(images)}개의 이미지 발견")
    
    final_content = "# 프로토타입 분리 결과\n\n"
    
    for idx, img_path in enumerate(images):
        print(f"2. 이미지 처리 중 ({idx+1}/{len(images)}): {img_path}")
        result = process_image_prototype(img_path, output_img_dir)
        final_content += result
        
    # 기존 md 파일에 텍스트가 있었는지 확인하고 추가 (프로토타입이므로 생략 가능하나 예제 차원)
    final_content += "\n\n(참고: 본 마크다운은 자동 분리 테스트 결과입니다.)"
        
    with open(output_md, 'w', encoding='utf-8') as f:
        f.write(final_content)
        
    print(f"\n완료! 결과가 {output_md} 에 저장되었습니다.")

if __name__ == "__main__":
    main()
