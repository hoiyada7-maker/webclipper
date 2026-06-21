use crate::ocr::Box2D;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct FigureRegion {
    pub bbox: Box2D,
    pub kind: String, // "figure" | "band"
}

/// Merge overlapping rects (with tolerance pixels)
fn merge_rects(mut rects: Vec<[f64; 4]>, tol: f64) -> Vec<[f64; 4]> {
    let mut merged = true;
    while merged {
        merged = false;
        let mut out: Vec<[f64; 4]> = Vec::new();
        let mut used = vec![false; rects.len()];
        for i in 0..rects.len() {
            if used[i] { continue; }
            let mut r = rects[i];
            for j in (i + 1)..rects.len() {
                if used[j] { continue; }
                let s = rects[j];
                // check overlap with tolerance
                if r[0] - tol < s[0] + s[2] && r[0] + r[2] + tol > s[0]
                    && r[1] - tol < s[1] + s[3] && r[1] + r[3] + tol > s[1]
                {
                    let x = r[0].min(s[0]);
                    let y = r[1].min(s[1]);
                    let x2 = (r[0] + r[2]).max(s[0] + s[2]);
                    let y2 = (r[1] + r[3]).max(s[1] + s[3]);
                    r = [x, y, x2 - x, y2 - y];
                    used[j] = true;
                    merged = true;
                }
            }
            out.push(r);
        }
        rects = out;
    }
    rects
}

/// Mask text word-boxes with median border pixel color, then detect figure regions
#[tauri::command]
pub fn auto_detect(
    img_path: String,
    word_boxes: Vec<Box2D>,
    min_area_ratio: Option<f64>,
) -> Result<Vec<FigureRegion>, String> {
    let img = image::open(&img_path).map_err(|e| e.to_string())?.into_rgba8();
    let (iw, ih) = (img.width(), img.height());
    let total = (iw * ih) as f64;
    let min_ratio = min_area_ratio.unwrap_or(0.005);

    // Mask text regions with border-median color (pad 10px)
    let mut masked = img.clone();
    for b in &word_boxes {
        let pad = 10u32;
        let x0 = (b.x.max(0.0) as u32).saturating_sub(pad);
        let y0 = (b.y.max(0.0) as u32).saturating_sub(pad);
        let x1 = (((b.x + b.w) as u32) + pad).min(iw);
        let y1 = (((b.y + b.h) as u32) + pad).min(ih);
        // Sample border pixels for median color
        let mut samples: Vec<[u8; 3]> = Vec::new();
        for bx in x0..x1 {
            if y0 < ih { let p = img.get_pixel(bx, y0); samples.push([p[0], p[1], p[2]]); }
            if y1 > 0 && y1 - 1 < ih { let p = img.get_pixel(bx, y1 - 1); samples.push([p[0], p[1], p[2]]); }
        }
        for by in y0..y1 {
            if x0 < iw { let p = img.get_pixel(x0, by); samples.push([p[0], p[1], p[2]]); }
            if x1 > 0 && x1 - 1 < iw { let p = img.get_pixel(x1 - 1, by); samples.push([p[0], p[1], p[2]]); }
        }
        let fill = if samples.is_empty() {
            [255u8, 255, 255]
        } else {
            let mut rs: Vec<u8> = samples.iter().map(|c| c[0]).collect();
            let mut gs: Vec<u8> = samples.iter().map(|c| c[1]).collect();
            let mut bs: Vec<u8> = samples.iter().map(|c| c[2]).collect();
            rs.sort_unstable(); gs.sort_unstable(); bs.sort_unstable();
            let m = samples.len() / 2;
            [rs[m], gs[m], bs[m]]
        };
        for px in x0..x1 {
            for py in y0..y1 {
                masked.put_pixel(px, py, image::Rgba([fill[0], fill[1], fill[2], 255]));
            }
        }
    }

    // Convert to luma, gaussian blur, threshold
    let gray = image::imageops::colorops::grayscale(&masked);
    // Estimate background: median of a 32-pixel border strip
    let mut border_vals: Vec<u8> = Vec::new();
    for x in 0..iw { border_vals.push(*gray.get_pixel(x, 0).0.first().unwrap_or(&255)); }
    for x in 0..iw { if ih > 0 { border_vals.push(*gray.get_pixel(x, ih - 1).0.first().unwrap_or(&255)); } }
    for y in 0..ih { border_vals.push(*gray.get_pixel(0, y).0.first().unwrap_or(&255)); }
    for y in 0..ih { if iw > 0 { border_vals.push(*gray.get_pixel(iw - 1, y).0.first().unwrap_or(&255)); } }
    border_vals.sort_unstable();
    let bg_val = border_vals.get(border_vals.len() / 2).copied().unwrap_or(255);
    let thresh_val: u8 = if bg_val > 127 {
        bg_val.saturating_sub(30)
    } else {
        bg_val.saturating_add(30)
    };

    // Binary threshold: pixel "different from background" = 255
    let binary = image::ImageBuffer::from_fn(iw, ih, |x, y| {
        let v = gray.get_pixel(x, y).0[0];
        let diff = if bg_val > v { bg_val - v } else { v - bg_val };
        if diff > thresh_val / 2 { image::Luma([255u8]) } else { image::Luma([0u8]) }
    });

    // Gaussian blur to join nearby blobs
    let blurred = imageproc::filter::gaussian_blur_f32(&binary, 3.0);
    let blurred_thresh = image::ImageBuffer::from_fn(iw, ih, |x, y| {
        let v = blurred.get_pixel(x, y).0[0];
        if v > 64 { image::Luma([255u8]) } else { image::Luma([0u8]) }
    });

    // Connected components
    let labels = imageproc::region_labelling::connected_components(
        &blurred_thresh,
        imageproc::region_labelling::Connectivity::Eight,
        image::Luma([0u8]),
    );

    // Bounding boxes per label
    use std::collections::HashMap;
    let mut bboxes: HashMap<u32, [u32; 4]> = HashMap::new();
    for (x, y, p) in labels.enumerate_pixels() {
        let lbl = p.0[0];
        if lbl == 0 { continue; }
        let e = bboxes.entry(lbl).or_insert([x, y, x, y]);
        e[0] = e[0].min(x);
        e[1] = e[1].min(y);
        e[2] = e[2].max(x);
        e[3] = e[3].max(y);
    }

    // Filter by area, convert to [x,y,w,h]
    let raw_rects: Vec<[f64; 4]> = bboxes.values()
        .map(|b| [b[0] as f64, b[1] as f64, (b[2] - b[0] + 1) as f64, (b[3] - b[1] + 1) as f64])
        .filter(|r| (r[2] * r[3]) / total >= min_ratio)
        .collect();

    let merged = merge_rects(raw_rects, 10.0);

    let regions: Vec<FigureRegion> = merged.into_iter()
        .map(|r| FigureRegion {
            bbox: Box2D { x: r[0], y: r[1], w: r[2], h: r[3] },
            kind: "figure".to_string(),
        })
        .collect();

    Ok(regions)
}

/// Detect full-width horizontal bands (charts / diagrams that span most of image width)
#[tauri::command]
pub fn detect_contours_fullwidth(
    img_path: String,
    word_boxes: Vec<Box2D>,
    min_area_pct: Option<f64>,
) -> Result<Vec<FigureRegion>, String> {
    let img = image::open(&img_path).map_err(|e| e.to_string())?.into_rgba8();
    let (iw, ih) = (img.width(), img.height());
    let min_width_frac = min_area_pct.unwrap_or(0.5);

    // Build masked image (same text masking logic)
    let mut masked = img.clone();
    for b in &word_boxes {
        let pad = 10u32;
        let x0 = (b.x.max(0.0) as u32).saturating_sub(pad);
        let y0 = (b.y.max(0.0) as u32).saturating_sub(pad);
        let x1 = (((b.x + b.w) as u32) + pad).min(iw);
        let y1 = (((b.y + b.h) as u32) + pad).min(ih);
        for px in x0..x1 {
            for py in y0..y1 {
                masked.put_pixel(px, py, image::Rgba([255, 255, 255, 255]));
            }
        }
    }
    let gray = image::imageops::colorops::grayscale(&masked);

    // For each row, check if it has "significant" non-white pixels
    let min_w = (iw as f64 * min_width_frac) as u32;
    let mut row_has_content = vec![false; ih as usize];
    for y in 0..ih {
        let mut non_white = 0u32;
        for x in 0..iw {
            if gray.get_pixel(x, y).0[0] < 200 { non_white += 1; }
        }
        row_has_content[y as usize] = non_white >= min_w / 4;
    }

    // Merge consecutive content rows into bands
    let mut bands: Vec<[u32; 2]> = Vec::new();
    let mut in_band = false;
    let mut band_start = 0u32;
    for (y, &has) in row_has_content.iter().enumerate() {
        match (in_band, has) {
            (false, true) => { in_band = true; band_start = y as u32; }
            (true, false) => {
                bands.push([band_start, y as u32]);
                in_band = false;
            }
            _ => {}
        }
    }
    if in_band { bands.push([band_start, ih]); }

    // Filter bands by height (at least 1% of image height)
    let min_h = (ih as f64 * 0.01) as u32;
    let regions: Vec<FigureRegion> = bands.into_iter()
        .filter(|b| b[1] - b[0] >= min_h)
        .map(|b| FigureRegion {
            bbox: Box2D { x: 0.0, y: b[0] as f64, w: iw as f64, h: (b[1] - b[0]) as f64 },
            kind: "band".to_string(),
        })
        .collect();

    Ok(regions)
}
