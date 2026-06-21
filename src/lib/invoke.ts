import { invoke } from "@tauri-apps/api/core";

export interface EmbedResult {
  out_path: string;
  img_count: number;
}

export interface ExtractResult {
  out_path: string;
  img_count: number;
  saved_files: string[];
}

export interface Box2D {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WordBox {
  text: string;
  bbox: Box2D;
}

export interface FigureRegion {
  bbox: Box2D;
  kind: string;
}

export interface MdImageRef {
  path: string;
  alt: string;
}

export function cmdEmbedImages(mdPath: string, outDir?: string): Promise<EmbedResult> {
  return invoke<EmbedResult>("embed_images", { mdPath, outDir: outDir ?? null });
}

export function cmdExtractImages(mdPath: string, outDir?: string): Promise<ExtractResult> {
  return invoke<ExtractResult>("extract_images", { mdPath, outDir: outDir ?? null });
}

export function cmdOcrWordBoxes(imgPath: string): Promise<WordBox[]> {
  return invoke<WordBox[]>("ocr_word_boxes", { imgPath });
}

export function cmdOcrText(imgPath: string, bbox?: Box2D): Promise<string> {
  return invoke<string>("ocr_text", { imgPath, bbox: bbox ?? null });
}

export function cmdCropImageB64(imgPath: string, bbox: Box2D): Promise<string> {
  return invoke<string>("crop_image_b64", { imgPath, bbox });
}

export function cmdReadImageB64(imgPath: string): Promise<string> {
  return invoke<string>("read_image_b64", { imgPath });
}

export function cmdAutoDetect(
  imgPath: string,
  wordBoxes: WordBox[],
  minAreaRatio?: number,
): Promise<FigureRegion[]> {
  return invoke<FigureRegion[]>("auto_detect", {
    imgPath,
    wordBoxes,
    minAreaRatio: minAreaRatio ?? null,
  });
}

export function cmdDetectContours(
  imgPath: string,
  wordBoxes: WordBox[],
  minAreaPct?: number,
): Promise<FigureRegion[]> {
  return invoke<FigureRegion[]>("detect_contours_fullwidth", {
    imgPath,
    wordBoxes,
    minAreaPct: minAreaPct ?? null,
  });
}

export function cmdParseMdImages(mdPath: string): Promise<MdImageRef[]> {
  return invoke<MdImageRef[]>("parse_md_images", { mdPath });
}

export function cmdIsOcrAvailable(): Promise<boolean> {
  return invoke<boolean>("is_ocr_available");
}

// ── OCR Studio (Phase A) ──────────────────────────────────────────────────────

export interface RegionBox {
  full: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegionReq {
  imgPath: string;
  bbox: RegionBox;
  origType: "text" | "figure";
}

export interface Region {
  id: string;
  imgPath: string;
  bbox: RegionBox;
  finalType: "text" | "figure";
  croppedB64: string;
  ocrText: string;
}

export interface BuildResult {
  outPath: string;
  textCount: number;
  figureCount: number;
  savedFiles: string[];
}

export function cmdPreviewExtract(regions: RegionReq[]): Promise<Region[]> {
  return invoke<Region[]>("preview_extract", { regions });
}

export function cmdBuildMdFromRegions(
  mdPath: string,
  regions: Region[],
  outDir?: string,
): Promise<BuildResult> {
  return invoke<BuildResult>("build_md_from_regions", {
    mdPath,
    regions,
    outDir: outDir ?? null,
  });
}
