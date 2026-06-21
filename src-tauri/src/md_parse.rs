use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct MdImageRef {
    pub path: String,
    pub alt: String,
}

/// Extract local (non-data-URI, non-http) image paths from a markdown file.
/// Paths are resolved relative to the MD file's directory.
#[tauri::command]
pub fn parse_md_images(md_path: String) -> Result<Vec<MdImageRef>, String> {
    let content = std::fs::read_to_string(&md_path).map_err(|e| e.to_string())?;
    let md_dir = std::path::Path::new(&md_path)
        .parent()
        .unwrap_or(std::path::Path::new(""))
        .to_owned();

    let re = regex::Regex::new(r"!\[([^\]]*)\]\(([^)]+)\)").unwrap();
    let mut refs = Vec::new();
    for cap in re.captures_iter(&content) {
        let alt = cap[1].to_string();
        let src = cap[2].trim().to_string();
        if src.starts_with("data:") || src.starts_with("http://") || src.starts_with("https://") {
            continue;
        }
        let decoded = crate::utils::percent_decode(src.trim());
        let rel = decoded.trim_start_matches("./").trim_start_matches('/');
        let abs = md_dir.join(rel);
        refs.push(MdImageRef {
            alt,
            path: abs.to_string_lossy().replace('/', "\\").to_string(),
        });
    }
    Ok(refs)
}
