use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct PdfResult {
    pub md_path: String,
    pub elapsed_ms: u64,
}

fn java_bin_name() -> &'static str {
    if cfg!(target_os = "windows") { "java.exe" } else { "java" }
}

fn strip_unc_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

/// Resolve (java binary, jar) paths, trying bundled resource locations first
/// (both `resource_dir()/resources/...` and `resource_dir()/...`, since Tauri's
/// resource layout can vary), then falling back to the dev-mode source tree.
pub fn runtime_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let java_name = java_bin_name();
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("resources"));
        candidates.push(dir);
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));

    for base in candidates {
        let java = base.join("jre").join("bin").join(java_name);
        let jar = base.join("opendataloader-pdf-cli.jar");
        if java.exists() && jar.exists() {
            // resource_dir()는 `\\?\C:\...` 확장 경로를 반환할 수 있는데
            // java가 `-jar \\?\...` 경로를 처리하지 못하므로 접두사를 제거한다
            return Ok((strip_unc_prefix(java), strip_unc_prefix(jar)));
        }
    }

    Err("PDF 변환 런타임(JRE+JAR)을 찾을 수 없습니다".into())
}

#[tauri::command]
pub fn is_pdf_available(app: AppHandle) -> bool {
    runtime_paths(&app).is_ok()
}

#[tauri::command]
pub fn convert_pdf(app: AppHandle, pdf_path: String, out_dir: Option<String>) -> Result<PdfResult, String> {
    let (java, jar) = runtime_paths(&app)?;

    let path = PathBuf::from(&pdf_path);
    let base_dir = path
        .parent()
        .ok_or("파일 경로에 부모 디렉터리가 없습니다")?
        .to_path_buf();

    let save_dir = if let Some(d) = out_dir {
        let p = PathBuf::from(d);
        std::fs::create_dir_all(&p).map_err(|e| format!("출력 폴더 생성 실패: {e}"))?;
        p
    } else {
        base_dir
    };

    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let start = Instant::now();

    let mut cmd = Command::new(&java);
    cmd.arg("-jar")
        .arg(&jar)
        .arg(&path)
        .arg("-o")
        .arg(&save_dir)
        .arg("-f")
        .arg("markdown");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output().map_err(|e| format!("PDF 변환 실행 실패: {e}"))?;

    if !output.status.success() {
        // 실제 오류 메시지("Error: ...")는 stdout, 로깅은 stderr로 나오므로 둘 다 합친다
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = format!("{stderr}\n{stdout}");
        let lines: Vec<&str> = combined.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = lines[lines.len().saturating_sub(10)..].join("\n");
        return Err(format!("PDF 변환 실패: {tail}"));
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let md_path = save_dir.join(format!("{stem}.md"));

    if !md_path.exists() {
        return Err(format!("변환은 완료됐지만 출력 파일을 찾을 수 없습니다: {}", md_path.display()));
    }

    Ok(PdfResult {
        md_path: md_path.to_string_lossy().to_string(),
        elapsed_ms,
    })
}
