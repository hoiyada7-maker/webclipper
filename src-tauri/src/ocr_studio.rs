use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};

// ── Data types ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionBox {
    pub full: bool,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Frontend → Rust: one image + box + desired mode
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionReq {
    pub img_path: String,
    pub bbox: RegionBox,
    pub orig_type: String, // "text" | "figure"
}

/// Rust → Frontend: crop preview + OCR result (editable)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub id: String,
    pub img_path: String,
    pub bbox: RegionBox,
    pub final_type: String, // "text" | "figure"  (user may toggle)
    pub cropped_b64: String,
    pub ocr_text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    pub out_path: String,
    pub text_count: usize,
    pub figure_count: usize,
    pub saved_files: Vec<String>,
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Batch crop (+ optional OCR) for preview before final build.
/// Missing or unreadable images produce a placeholder region instead of failing the batch.
#[tauri::command]
pub fn preview_extract(regions: Vec<RegionReq>) -> Result<Vec<Region>, String> {
    let mut out = Vec::with_capacity(regions.len());
    for (i, req) in regions.iter().enumerate() {
        let img_result = image::open(&req.img_path).map(|i| i.into_rgba8());

        let (cropped_b64, ocr_text) = match img_result {
            Err(e) => {
                let msg = format!("[이미지 없음: {}] {e}", req.img_path);
                (String::new(), msg)
            }
            Ok(img) => {
                let crop = crop_rgba(&img, &req.bbox);
                let mut buf = std::io::Cursor::new(Vec::<u8>::new());
                let b64 = match crop.write_to(&mut buf, image::ImageFormat::Png) {
                    Ok(()) => format!(
                        "data:image/png;base64,{}",
                        general_purpose::STANDARD.encode(buf.get_ref())
                    ),
                    Err(_) => String::new(),
                };
                let ocr = if req.orig_type == "text" {
                    crate::ocr::run_ocr_image(&crop)
                        .unwrap_or_else(|e| format!("[OCR 실패: {e}]"))
                } else {
                    String::new()
                };
                (b64, ocr)
            }
        };

        out.push(Region {
            id: format!("r{i}"),
            img_path: req.img_path.clone(),
            bbox: req.bbox.clone(),
            final_type: req.orig_type.clone(),
            cropped_b64,
            ocr_text,
        });
    }
    Ok(out)
}

/// Assemble final OCR MD: substitute image links with text or figure crops.
/// Unmapped image links are kept as-is (원본 충실성).
#[tauri::command]
pub fn build_md_from_regions(
    md_path: String,
    regions: Vec<Region>,
    out_dir: Option<String>,
) -> Result<BuildResult, String> {
    let path = PathBuf::from(&md_path);
    let md_dir = path.parent().ok_or("MD 파일 경로 오류")?.to_owned();
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    // Sanitize then truncate to 18 chars for figure filenames
    let safe_stem = {
        let s = sanitize_stem(&stem);
        let end = s.char_indices().nth(18).map(|(i, _)| i).unwrap_or(s.len());
        s[..end].trim_end_matches('_').to_string()
    };

    let save_dir = if let Some(d) = out_dir {
        let p = PathBuf::from(d);
        std::fs::create_dir_all(&p).map_err(|e| format!("출력 폴더 생성 실패: {e}"))?;
        p
    } else {
        md_dir.clone()
    };

    let assets_dir = save_dir.join("assets");
    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("assets 폴더 생성 실패: {e}"))?;

    let md = std::fs::read_to_string(&path).map_err(|e| format!("MD 읽기 실패: {e}"))?;
    let ts = timestamp_str();

    // Group regions by normalised absolute img_path
    let mut by_path: HashMap<String, Vec<&Region>> = HashMap::new();
    for r in &regions {
        by_path.entry(norm_path(&r.img_path)).or_default().push(r);
    }

    let re = regex::Regex::new(r"!\[([^\]]*)\]\(([^)]+)\)").map_err(|e| e.to_string())?;

    let mut result = String::with_capacity(md.len() + md.len() / 4);
    let mut text_count = 0usize;
    let mut figure_count = 0usize;
    let mut saved_files: Vec<String> = Vec::new();
    let mut fig_n = 0usize;
    let mut last = 0usize;

    for cap in re.captures_iter(&md) {
        let full = cap.get(0).unwrap();
        let alt = &cap[1];
        let src = cap[2].trim();

        result.push_str(&md[last..full.start()]);
        last = full.end();

        // data URIs and HTTP links — keep verbatim
        if src.starts_with("data:") || src.starts_with("http://") || src.starts_with("https://") {
            result.push_str(full.as_str());
            continue;
        }

        // Resolve link → absolute path (same logic as md_parse.rs)
        let decoded = crate::utils::percent_decode(src);
        let rel = decoded.trim_start_matches("./").trim_start_matches('/');
        let abs = md_dir.join(rel);
        let key = norm_path(&abs.to_string_lossy());

        match by_path.get(&key) {
            None => {
                // No region assigned → keep original link
                result.push_str(full.as_str());
            }
            Some(regs) => {
                let mut parts: Vec<String> = Vec::new();
                for reg in regs {
                    if reg.final_type == "text" && !reg.ocr_text.trim().is_empty() {
                        parts.push(reg.ocr_text.trim().to_string());
                        text_count += 1;
                    } else {
                        // figure, or text-mode with empty OCR → save as figure
                        fig_n += 1;
                        let img_name = format!("{safe_stem}_fig{fig_n:03}.png");
                        let dst = assets_dir.join(&img_name);
                        match save_region_png(&reg.img_path, &reg.bbox, &dst) {
                            Ok(()) => {
                                saved_files.push(img_name.clone());
                                figure_count += 1;
                                parts.push(format!("![{alt}](./assets/{img_name})"));
                            }
                            Err(_) => {
                                // Image missing/unreadable → keep original link
                                fig_n -= 1;
                                parts.push(full.as_str().to_string());
                            }
                        }
                    }
                }
                result.push_str(&parts.join("\n\n"));
            }
        }
    }
    result.push_str(&md[last..]);

    let out_name = format!("{stem}_OCR_{ts}.md");
    let out_path = save_dir.join(&out_name);
    std::fs::write(&out_path, &result).map_err(|e| format!("MD 저장 실패: {e}"))?;

    Ok(BuildResult {
        out_path: out_path.to_string_lossy().to_string(),
        text_count,
        figure_count,
        saved_files,
    })
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn crop_rgba(img: &image::RgbaImage, bbox: &RegionBox) -> image::RgbaImage {
    let (iw, ih) = (img.width(), img.height());
    let (x, y, w, h) = if bbox.full {
        (0, 0, iw, ih)
    } else {
        let x = (bbox.x.max(0.0) as u32).min(iw.saturating_sub(1));
        let y = (bbox.y.max(0.0) as u32).min(ih.saturating_sub(1));
        let w = (bbox.w as u32).min(iw.saturating_sub(x)).max(1);
        let h = (bbox.h as u32).min(ih.saturating_sub(y)).max(1);
        (x, y, w, h)
    };
    image::imageops::crop_imm(img, x, y, w, h).to_image()
}

fn save_region_png(img_path: &str, bbox: &RegionBox, dst: &PathBuf) -> Result<(), String> {
    let img = image::open(img_path)
        .map_err(|e| format!("이미지 로드 실패 ({img_path}): {e}"))?
        .into_rgba8();
    let crop = crop_rgba(&img, bbox);
    crop.save(dst).map_err(|e| format!("PNG 저장 실패: {e}"))
}

/// Normalise path for HashMap key: backslashes + lowercase (Windows).
fn norm_path(p: &str) -> String {
    p.replace('/', "\\").to_ascii_lowercase()
}

/// Strip characters that break Markdown image links or are problematic in filenames.
/// Spaces → `_`, `[` `]` `(` `)` `,` `;` `*` `?` `"` `<` `>` `|` → `_`,
/// then collapse consecutive underscores.
fn sanitize_stem(s: &str) -> String {
    let replaced: String = s
        .chars()
        .map(|c| match c {
            ' ' | '[' | ']' | '(' | ')' | ',' | ';' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    // Collapse runs of underscores to a single one, trim trailing/leading
    let mut out = String::with_capacity(replaced.len());
    let mut last_underscore = false;
    for c in replaced.chars() {
        if c == '_' {
            if !last_underscore && !out.is_empty() {
                out.push('_');
            }
            last_underscore = true;
        } else {
            out.push(c);
            last_underscore = false;
        }
    }
    // Trim trailing underscore
    out.trim_end_matches('_').to_string()
}

fn timestamp_str() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let total_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let sec = (total_secs % 60) as u32;
    let min = ((total_secs / 60) % 60) as u32;
    let hour = ((total_secs / 3600) % 24) as u32;
    let mut days = (total_secs / 86400) as i64;

    let mut year = 1970i64;
    loop {
        let dy: i64 = if is_leap(year) { 366 } else { 365 };
        if days < dy {
            break;
        }
        days -= dy;
        year += 1;
    }
    let month_days: [i64; 12] = [
        31,
        if is_leap(year) { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 1u32;
    for &dm in &month_days {
        if days < dm {
            break;
        }
        days -= dm;
        month += 1;
    }
    let day = (days + 1) as u32;

    format!("{year:04}{month:02}{day:02}{hour:02}{min:02}{sec:02}")
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_removes_spaces_and_brackets() {
        let input = "2026-06-21 191808 [학교폭력] 온라인 저격글, 글이 사라지는 인스타스토리_extracted";
        let out = sanitize_stem(input);
        assert!(!out.contains(' '), "spaces must be gone");
        assert!(!out.contains('['), "[ must be gone");
        assert!(!out.contains(']'), "] must be gone");
        assert!(!out.contains(','), ", must be gone");
        assert!(!out.ends_with('_'), "no trailing underscore");
        // Should not have consecutive underscores
        assert!(!out.contains("__"), "no consecutive underscores: {out}");
    }

    #[test]
    fn sanitize_plain_name() {
        assert_eq!(sanitize_stem("my_doc"), "my_doc");
    }
}

