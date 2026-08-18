use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct ExtractResult {
    pub out_path: String,
    pub img_count: usize,
    pub saved_files: Vec<String>,
}

#[tauri::command]
pub fn extract_images(md_path: String, out_dir: Option<String>) -> Result<ExtractResult, String> {
    let path = PathBuf::from(&md_path);
    let base_dir = path
        .parent()
        .ok_or("파일 경로에 부모 디렉터리가 없습니다")?
        .to_path_buf();

    let save_dir = if let Some(d) = out_dir {
        let p = PathBuf::from(d);
        std::fs::create_dir_all(&p).map_err(|e| format!("출력 폴더 생성 실패: {e}"))?;
        p
    } else {
        base_dir.clone()
    };

    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let md = std::fs::read_to_string(&path)
        .map_err(|e| format!("파일 읽기 실패: {e}"))?;

    let assets_dir = save_dir.join("assets");
    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("assets 폴더 생성 실패: {e}"))?;

    // 모든 이미지 링크 매칭 (base64 + 로컬 파일 경로 모두)
    let re = regex::Regex::new(r"!\[([^\]]*)\]\(([^)]+)\)")
        .map_err(|e| e.to_string())?;

    let mut result = String::with_capacity(md.len());
    let mut img_count = 0usize;
    let mut saved_files: Vec<String> = Vec::new();
    let mut last = 0usize;
    let mut counter = 0usize;

    for caps in re.captures_iter(&md) {
        let full = caps.get(0).unwrap();
        let alt = &caps[1];
        let src = caps[2].trim();

        result.push_str(&md[last..full.start()]);

        if src.starts_with("data:image/") {
            // Base64 데이터 URI → 파일로 추출
            let replaced = parse_data_uri(src).and_then(|(ext, payload)| {
                let raw = general_purpose::STANDARD.decode(payload).ok()?;
                counter += 1;
                let img_name = format!("{stem}_img_{counter:03}.{ext}");
                let img_path = assets_dir.join(&img_name);
                // 동일 파일명 존재 시 건너뜀
                if img_path.exists() {
                    return Some(format!("![{alt}](./assets/{})", encode_spaces(&img_name)));
                }
                std::fs::write(&img_path, &raw).ok()?;
                saved_files.push(img_name.clone());
                img_count += 1;
                Some(format!("![{alt}](./assets/{})", encode_spaces(&img_name)))
            });
            result.push_str(replaced.as_deref().unwrap_or(full.as_str()));
        } else if !src.starts_with("http://") && !src.starts_with("https://") && !src.starts_with("data:") {
            // 로컬 파일 링크 → assets/ 로 복사
            let decoded = src.replace("%20", " ");
            let rel = decoded.trim_start_matches("./").trim_start_matches('/');
            let src_file = base_dir.join(rel);

            if src_file.exists() {
                if let Some(file_name) = src_file.file_name().map(|n| n.to_string_lossy().to_string()) {
                    let dst = assets_dir.join(&file_name);
                    if !dst.exists() {
                        // 동일 파일명 없을 때만 복사
                        std::fs::copy(&src_file, &dst)
                            .map_err(|e| format!("이미지 복사 실패 ({file_name}): {e}"))?;
                        saved_files.push(file_name.clone());
                        img_count += 1;
                    }
                    result.push_str(&format!("![{alt}](./assets/{})", encode_spaces(&file_name)));
                } else {
                    result.push_str(full.as_str());
                }
            } else {
                // 파일을 찾을 수 없으면 원본 링크 유지
                result.push_str(full.as_str());
            }
        } else {
            // http/https 링크는 그대로 유지
            result.push_str(full.as_str());
        }

        last = full.end();
    }
    result.push_str(&md[last..]);

    let out_name = format!("{stem}_extracted.md");
    let out_path = save_dir.join(&out_name);
    std::fs::write(&out_path, &result).map_err(|e| format!("파일 저장 실패: {e}"))?;

    Ok(ExtractResult {
        out_path: out_path.to_string_lossy().to_string(),
        img_count,
        saved_files,
    })
}

/// 마크다운 링크 목적지는 공백에서 끊긴다 — 파일명의 공백을 %20으로 인코딩한다.
/// 읽는 쪽(`utils::percent_decode`, embed.rs)이 %20을 다시 공백으로 되돌린다.
fn encode_spaces(name: &str) -> String {
    name.replace(' ', "%20")
}

fn parse_data_uri(uri: &str) -> Option<(String, &str)> {
    let after = uri.strip_prefix("data:image/")?;
    let semi = after.find(';')?;
    let ext = subtype_to_ext(&after[..semi]);
    let rest = &after[semi + 1..];
    let payload = rest.strip_prefix("base64,")?;
    Some((ext, payload))
}

/// data URI 서브타입 → 파일 확장자. `svg+xml`, `x-icon`처럼 확장자로 쓸 수 없는
/// 서브타입을 그대로 파일명에 붙이면 이미지로 인식되지 않아 프리뷰에서 깨진다.
fn subtype_to_ext(subtype: &str) -> String {
    match subtype {
        "jpeg" => return "jpg".to_string(),
        "svg+xml" => return "svg".to_string(),
        "x-icon" | "vnd.microsoft.icon" => return "ico".to_string(),
        _ => {}
    }
    // 그 밖의 서브타입은 접미사(`+xml` 등)를 떼고 영숫자만 남긴다.
    let base: String = subtype
        .split('+')
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if base.is_empty() {
        "png".to_string()
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subtype_normalized() {
        assert_eq!(subtype_to_ext("png"), "png");
        assert_eq!(subtype_to_ext("jpeg"), "jpg");
        assert_eq!(subtype_to_ext("svg+xml"), "svg");
        assert_eq!(subtype_to_ext("x-icon"), "ico");
        assert_eq!(subtype_to_ext("vnd.microsoft.icon"), "ico");
        assert_eq!(subtype_to_ext("webp"), "webp");
        assert_eq!(subtype_to_ext("*"), "png");
    }

    #[test]
    fn data_uri_ext_and_payload() {
        assert_eq!(
            parse_data_uri("data:image/svg+xml;base64,QUJD"),
            Some(("svg".to_string(), "QUJD"))
        );
        assert_eq!(parse_data_uri("data:image/png,QUJD"), None);
    }

    #[test]
    fn spaces_encoded_korean_kept() {
        assert_eq!(encode_spaces("a b.png"), "a%20b.png");
        assert_eq!(encode_spaces("사진 1.png"), "사진%201.png");
        assert_eq!(encode_spaces("plain.png"), "plain.png");
    }

    #[test]
    fn encode_decode_round_trip() {
        let name = "2026-08-18 185122 PLC 약어 - Google Ge_img_001.png";
        assert_eq!(crate::utils::percent_decode(&encode_spaces(name)), name);
    }
}
