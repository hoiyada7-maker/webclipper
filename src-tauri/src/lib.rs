mod embed;
mod utils;
mod extract;
mod figures;
mod md_parse;
mod ocr;
mod ocr_studio;

use embed::embed_images;
use extract::extract_images;
use figures::{auto_detect, detect_contours_fullwidth};
use md_parse::parse_md_images;
use ocr::{crop_image_b64, ocr_text, ocr_word_boxes, read_image_b64};
use ocr_studio::{build_md_from_regions, preview_extract};

#[tauri::command]
fn is_ocr_available() -> bool {
    cfg!(target_os = "windows")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            embed_images,
            extract_images,
            ocr_word_boxes,
            ocr_text,
            crop_image_b64,
            read_image_b64,
            auto_detect,
            detect_contours_fullwidth,
            parse_md_images,
            preview_extract,
            build_md_from_regions,
            is_ocr_available,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
