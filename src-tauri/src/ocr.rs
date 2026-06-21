use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Box2D {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WordBox {
    pub text: String,
    pub bbox: Box2D,
}

// ── Windows OCR internals ────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn rgba_to_software_bitmap(img: &image::RgbaImage) -> windows::core::Result<windows::Graphics::Imaging::SoftwareBitmap> {
    use windows::{
        Graphics::Imaging::{BitmapBufferAccessMode, BitmapPixelFormat, SoftwareBitmap},
        Win32::System::WinRT::IMemoryBufferByteAccess,
    };
    let (w, h) = (img.width() as i32, img.height() as i32);
    let bitmap = SoftwareBitmap::Create(BitmapPixelFormat::Bgra8, w, h)?;
    {
        let buf = bitmap.LockBuffer(BitmapBufferAccessMode::Write)?;
        let ref_ = buf.CreateReference()?;
        let byte_access: IMemoryBufferByteAccess = windows::core::Interface::cast(&ref_)?;
        let mut ptr: *mut u8 = std::ptr::null_mut();
        let mut cap: u32 = 0;
        unsafe {
            byte_access.GetBuffer(&mut ptr, &mut cap)?;
            let pixels = img.as_raw();
            for i in 0..(w * h) as usize {
                *ptr.add(i * 4)     = pixels[i * 4 + 2]; // B
                *ptr.add(i * 4 + 1) = pixels[i * 4 + 1]; // G
                *ptr.add(i * 4 + 2) = pixels[i * 4];     // R
                *ptr.add(i * 4 + 3) = pixels[i * 4 + 3]; // A
            }
        }
    }
    Ok(bitmap)
}

#[cfg(target_os = "windows")]
fn ocr_pass(
    bitmap: &windows::Graphics::Imaging::SoftwareBitmap,
    lang_tag: &str,
) -> windows::core::Result<Vec<WordBox>> {
    use windows::{core::HSTRING, Globalization::Language, Media::Ocr::OcrEngine};
    let lang = Language::CreateLanguage(&HSTRING::from(lang_tag))?;
    if !OcrEngine::IsLanguageSupported(&lang)? {
        return Ok(vec![]);
    }
    let engine = OcrEngine::TryCreateFromLanguage(&lang)?;
    let result = engine.RecognizeAsync(bitmap)?.get()?;
    let mut words = Vec::new();
    for line in result.Lines()? {
        for word in line.Words()? {
            let text = word.Text()?.to_string();
            let r = word.BoundingRect()?;
            words.push(WordBox {
                text,
                bbox: Box2D { x: r.X as f64, y: r.Y as f64, w: r.Width as f64, h: r.Height as f64 },
            });
        }
    }
    Ok(words)
}

// ── pub(crate) OCR on in-memory image (used by ocr_studio) ──────────────────

#[cfg(target_os = "windows")]
pub(crate) fn run_ocr_image(img: &image::RgbaImage) -> Result<String, String> {
    use windows::{core::HSTRING, Globalization::Language, Media::Ocr::OcrEngine};
    let bitmap = rgba_to_software_bitmap(img).map_err(|e| e.to_string())?;

    // Try preferred language then fall back to en-US
    let mut chosen_lang = None;
    for tag in &["ko-KR", "en-US"] {
        let l = Language::CreateLanguage(&HSTRING::from(*tag)).map_err(|e| e.to_string())?;
        if OcrEngine::IsLanguageSupported(&l).map_err(|e| e.to_string())? {
            chosen_lang = Some(l);
            break;
        }
    }
    let lang = chosen_lang.ok_or_else(|| {
        "OCR 언어팩이 설치되지 않았습니다. Windows 설정 > 언어에서 한국어(ko-KR)를 추가하세요.".to_string()
    })?;

    let engine = OcrEngine::TryCreateFromLanguage(&lang).map_err(|e| e.to_string())?;
    let result = engine.RecognizeAsync(&bitmap).map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    let text = result.Lines().map_err(|e| e.to_string())?
        .into_iter()
        .map(|l| l.Text().map(|t| t.to_string()).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(text)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn run_ocr_image(_img: &image::RgbaImage) -> Result<String, String> {
    Err("Windows 전용 기능입니다".into())
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Word-level OCR bounding boxes (ko-KR + en-US, deduplicated by position)
#[tauri::command]
pub fn ocr_word_boxes(img_path: String) -> Result<Vec<WordBox>, String> {
    #[cfg(not(target_os = "windows"))]
    return Err("Windows 전용 기능입니다".into());

    #[cfg(target_os = "windows")]
    {
        let img = image::open(&img_path)
            .map_err(|e| format!("이미지 로드 실패: {e}"))?.into_rgba8();
        let bitmap = rgba_to_software_bitmap(&img).map_err(|e| e.to_string())?;
        let mut all: Vec<WordBox> = Vec::new();
        for lang in &["ko-KR", "en-US"] {
            let mut pass = ocr_pass(&bitmap, lang).map_err(|e| e.to_string())?;
            all.append(&mut pass);
        }
        // Deduplicate: same position within 5px (two OCR passes can produce duplicates)
        let mut unique: Vec<WordBox> = Vec::new();
        for b in all {
            let dup = unique.iter().any(|u| {
                (b.bbox.x - u.bbox.x).abs() < 5.0 && (b.bbox.y - u.bbox.y).abs() < 5.0
            });
            if !dup {
                unique.push(b);
            }
        }
        unique.sort_by(|a, b| a.bbox.y.partial_cmp(&b.bbox.y).unwrap_or(std::cmp::Ordering::Equal));
        Ok(unique)
    }
}

/// OCR line-text from image, with optional crop box
#[tauri::command]
pub fn ocr_text(img_path: String, bbox: Option<Box2D>) -> Result<String, String> {
    #[cfg(not(target_os = "windows"))]
    return Err("Windows 전용 기능입니다".into());

    #[cfg(target_os = "windows")]
    {
        use windows::{core::HSTRING, Globalization::Language, Media::Ocr::OcrEngine};
        let mut img = image::open(&img_path)
            .map_err(|e| format!("이미지 로드 실패: {e}"))?.into_rgba8();
        if let Some(b) = bbox {
            let x = (b.x.max(0.0) as u32).min(img.width().saturating_sub(1));
            let y = (b.y.max(0.0) as u32).min(img.height().saturating_sub(1));
            let w = (b.w as u32).min(img.width().saturating_sub(x));
            let h = (b.h as u32).min(img.height().saturating_sub(y));
            img = image::imageops::crop_imm(&img, x, y, w.max(1), h.max(1)).to_image();
        }
        let bitmap = rgba_to_software_bitmap(&img).map_err(|e| e.to_string())?;
        let lang = Language::CreateLanguage(&HSTRING::from("ko-KR")).map_err(|e| e.to_string())?;
        let engine = OcrEngine::TryCreateFromLanguage(&lang)
            .map_err(|e| e.to_string())?;
        let result = engine.RecognizeAsync(&bitmap)
            .map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
        let text = result.Lines().map_err(|e| e.to_string())?
            .into_iter()
            .map(|l| l.Text().map(|t| t.to_string()).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n");
        Ok(text)
    }
}

/// Crop image region → base64 PNG data URI
#[tauri::command]
pub fn crop_image_b64(img_path: String, bbox: Box2D) -> Result<String, String> {
    let img = image::open(&img_path).map_err(|e| e.to_string())?.into_rgba8();
    let x = (bbox.x.max(0.0) as u32).min(img.width().saturating_sub(1));
    let y = (bbox.y.max(0.0) as u32).min(img.height().saturating_sub(1));
    let w = (bbox.w as u32).min(img.width().saturating_sub(x)).max(1);
    let h = (bbox.h as u32).min(img.height().saturating_sub(y)).max(1);
    let crop = image::imageops::crop_imm(&img, x, y, w, h).to_image();
    let mut buf = std::io::Cursor::new(Vec::new());
    crop.write_to(&mut buf, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", general_purpose::STANDARD.encode(buf.get_ref())))
}

/// Read any local image file → base64 data URI (for display in UI)
#[tauri::command]
pub fn read_image_b64(img_path: String) -> Result<String, String> {
    let bytes = std::fs::read(&img_path).map_err(|e| e.to_string())?;
    let ext = std::path::Path::new(&img_path)
        .extension().and_then(|e| e.to_str()).unwrap_or("png")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif"          => "image/gif",
        "webp"         => "image/webp",
        "svg"          => "image/svg+xml",
        _              => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", general_purpose::STANDARD.encode(&bytes)))
}
