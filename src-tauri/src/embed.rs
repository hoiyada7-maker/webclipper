use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct EmbedResult {
    pub out_path: String,
    pub img_count: usize,
}

#[tauri::command]
pub fn embed_images(md_path: String, out_dir: Option<String>) -> Result<EmbedResult, String> {
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

    let md = std::fs::read_to_string(&path)
        .map_err(|e| format!("파일 읽기 실패: {e}"))?;

    let re = regex::Regex::new(r"!\[([^\]]*)\]\(([^)]+)\)")
        .map_err(|e| e.to_string())?;

    let mut result = String::with_capacity(md.len() + md.len() / 4);
    let mut img_count = 0usize;
    let mut last = 0usize;

    for caps in re.captures_iter(&md) {
        let full = caps.get(0).unwrap();
        let alt = &caps[1];
        let path_str = caps[2].trim();

        result.push_str(&md[last..full.start()]);

        // data: 및 http 링크는 그대로 유지
        if path_str.starts_with("data:")
            || path_str.starts_with("http://")
            || path_str.starts_with("https://")
        {
            result.push_str(full.as_str());
        } else {
            let decoded = path_str.replace("%20", " ");
            let rel = decoded
                .trim_start_matches("./")
                .trim_start_matches('/');
            let file_path = base_dir.join(rel);

            let replaced = std::fs::read(&file_path)
                .ok()
                .map(|bytes| {
                    let mime = guess_mime(&file_path);
                    let b64 = general_purpose::STANDARD.encode(&bytes);
                    img_count += 1;
                    format!("![{alt}](data:{mime};base64,{b64})")
                });

            result.push_str(replaced.as_deref().unwrap_or(full.as_str()));
        }

        last = full.end();
    }
    result.push_str(&md[last..]);

    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let out_name = format!("{stem}_embedded.md");
    let out_path = save_dir.join(&out_name);
    std::fs::write(&out_path, &result).map_err(|e| format!("파일 저장 실패: {e}"))?;

    Ok(EmbedResult {
        out_path: out_path.to_string_lossy().to_string(),
        img_count,
    })
}

fn guess_mime(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => "image/png",
    }
}
