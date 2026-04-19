import opendataloader_pdf
import os
import argparse

def convert_images_to_md(input_paths, output_dir, hybrid_url="http://localhost:5002"):
    """
    opendataloader-pdf의 Hybrid Mode를 사용하여 PNG/PDF 등의 파일을 Markdown으로 변환합니다.
    webclipper 서버 구동 시 자동 시작되는 hybrid OCR 서버(port 5002)를 사용합니다.
    """
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    print(f"변환 시작: {input_paths}")

    opendataloader_pdf.convert(
        input_path=input_paths,
        output_dir=output_dir,
        format="markdown",
        hybrid="docling-fast",
        hybrid_url=hybrid_url,
        hybrid_mode="full",   # 모든 페이지를 OCR 백엔드로 처리
        hybrid_fallback=True, # 백엔드 오류 시 Java fallback
    )

    print(f"변환 완료. 결과물은 '{output_dir}' 폴더에 저장되었습니다.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PNG/PDF 파일을 Markdown으로 변환합니다.")
    parser.add_argument("inputs", nargs="+", help="변환할 파일 또는 폴더 경로들")
    parser.add_argument("-o", "--output", default="output/", help="결과물이 저장될 폴더 경로 (기본값: output/)")
    parser.add_argument("--hybrid-url", default="http://localhost:5002", help="hybrid OCR 서버 URL (기본값: http://localhost:5002)")

    args = parser.parse_args()

    convert_images_to_md(args.inputs, args.output, args.hybrid_url)
