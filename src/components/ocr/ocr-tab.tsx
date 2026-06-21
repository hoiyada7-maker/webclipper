import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import {
  cmdBuildMdFromRegions,
  cmdParseMdImages,
  cmdPreviewExtract,
  type MdImageRef,
  type Region,
  type RegionBox,
  type RegionReq,
} from "@/lib/invoke";
import { ModeSelector, type Assignment, type AssignMode } from "./mode-selector";
import { RegionPreview } from "./region-preview";

type Stage = "select" | "assign" | "preview-loading" | "review" | "build-loading" | "done";

type Props = {
  onToast: (msg: string, variant?: "error" | "success") => void;
  workDir?: string;
};

export function OcrTab({ onToast, workDir }: Props) {
  const [stage, setStage] = useState<Stage>("select");
  const [mdPath, setMdPath] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [done, setDone] = useState<{ outPath: string; textCount: number; figureCount: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragRef = useRef(0);

  const loadMd = useCallback(async (path: string) => {
    try {
      const images: MdImageRef[] = await cmdParseMdImages(path);
      if (!images.length) {
        onToast("이미지 링크가 없는 MD 파일입니다", "error");
        return;
      }
      setMdPath(path);
      setAssignments(images.map(img => ({ image: img, mode: "full-figure" as AssignMode, bbox: null })));
      setRegions([]);
      setDone(null);
      setStage("assign");
    } catch (e) {
      onToast(`MD 로드 실패: ${e}`, "error");
    }
  }, [onToast]);

  // Drag-drop listener
  useEffect(() => {
    let unDrop: (() => void) | undefined;
    let unEnter: (() => void) | undefined;
    let unLeave: (() => void) | undefined;

    void listen<{ paths: string[] }>("tauri://drag-enter", () => {
      dragRef.current++;
      setDragOver(true);
    }).then(u => { unEnter = u; });

    void listen<{ paths: string[] }>("tauri://drag-drop", e => {
      dragRef.current = 0;
      setDragOver(false);
      const p = e.payload.paths[0];
      if (p?.toLowerCase().endsWith(".md")) void loadMd(p);
      else onToast("MD 파일만 지원합니다", "error");
    }).then(u => { unDrop = u; });

    void listen("tauri://drag-leave", () => {
      dragRef.current = Math.max(0, dragRef.current - 1);
      if (dragRef.current === 0) setDragOver(false);
    }).then(u => { unLeave = u; });

    return () => { unDrop?.(); unEnter?.(); unLeave?.(); };
  }, [loadMd, onToast]);

  const pickMd = useCallback(async () => {
    const p = await openDialog({
      filters: [{ name: "Markdown", extensions: ["md"] }],
      multiple: false,
    });
    if (typeof p === "string" && p) void loadMd(p);
  }, [loadMd]);

  // Assign → Preview
  const runPreview = useCallback(async () => {
    const active = assignments;
    const missingBox = active.filter(
      a => (a.mode === "partial-figure" || a.mode === "partial-text") && !a.bbox,
    );
    if (missingBox.length) {
      onToast(`부분 모드 이미지 ${missingBox.length}개에 박스가 없습니다`, "error");
      return;
    }
    setStage("preview-loading");
    try {
      const reqs: RegionReq[] = active.map(a => {
        const full = a.mode === "full-figure" || a.mode === "full-text";
        const origType = (a.mode === "full-text" || a.mode === "partial-text") ? "text" : "figure";
        const bbox: RegionBox = full
          ? { full: true, x: 0, y: 0, w: 0, h: 0 }
          : { full: false, x: a.bbox!.x, y: a.bbox!.y, w: a.bbox!.w, h: a.bbox!.h };
        return { imgPath: a.image.path, bbox, origType };
      });
      const result = await cmdPreviewExtract(reqs);
      setRegions(result);
      setStage("review");
    } catch (e) {
      onToast(`미리보기 실패: ${e}`, "error");
      setStage("assign");
    }
  }, [assignments, onToast]);

  // Review → Build
  const runBuild = useCallback(async () => {
    if (!mdPath) return;
    setStage("build-loading");
    try {
      const result = await cmdBuildMdFromRegions(mdPath, regions, workDir || undefined);
      setDone({ outPath: result.outPath, textCount: result.textCount, figureCount: result.figureCount });
      setStage("done");
      onToast(`MD 생성 완료 — 텍스트 ${result.textCount}개·그림 ${result.figureCount}개`, "success");
    } catch (e) {
      onToast(`MD 생성 실패: ${e}`, "error");
      setStage("review");
    }
  }, [mdPath, regions, workDir, onToast]);

  const updateRegion = useCallback((updated: Region) => {
    setRegions(prev => prev.map(r => r.id === updated.id ? updated : r));
  }, []);

  const mdName = mdPath?.replace(/\\/g, "/").split("/").pop() ?? "";

  // ── Select stage ────────────────────────────────────────────────────────────
  if (stage === "select") {
    return (
      <div className="ocr-tab">
        <div className="tbox-tab__header">
          <h2>✨ OCR Studio</h2>
          <p className="tbox-tab__desc">
            MD 파일을 선택하면 포함된 이미지마다 처리 방식을 지정할 수 있습니다.<br />
            텍스트 영역 → Windows OCR 추출, 그림 영역 → PNG 크롭으로 MD를 재구성합니다.
          </p>
        </div>
        <div
          className={`tbox-drop${dragOver ? " is-drag-over" : ""}`}
          onClick={pickMd}
          role="button" tabIndex={0}
          onKeyDown={e => e.key === "Enter" && void pickMd()}
          style={{ minHeight: 200, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}
        >
          <div style={{ fontSize: 36 }}>📄</div>
          <div>MD 파일 드래그하거나 클릭해서 선택</div>
          <div className="tbox-drop__hint">.md 파일 (이미지 링크 포함)</div>
        </div>
      </div>
    );
  }

  // ── Loading stages ──────────────────────────────────────────────────────────
  if (stage === "preview-loading" || stage === "build-loading") {
    return (
      <div className="ocr-tab">
        <div className="tbox-placeholder">
          <div className="tbox-placeholder__icon">⏳</div>
          <h3>{stage === "preview-loading" ? "미리보기 생성 중…" : "MD 파일 생성 중…"}</h3>
          <p>잠시 기다려 주세요</p>
        </div>
      </div>
    );
  }

  // ── Assign stage ────────────────────────────────────────────────────────────
  if (stage === "assign") {
    const needsBox = assignments.some(
      a => (a.mode === "partial-figure" || a.mode === "partial-text") && !a.bbox,
    );
    const canPreview = assignments.length > 0 && !needsBox;

    return (
      <div className="ocr-tab">
        <div className="ocr-topbar">
          <button className="ocr-topbar__md-btn" onClick={pickMd} title={mdPath ?? undefined}>
            📄 {mdName}
          </button>
          <button
            className="tbox-btn tbox-btn--primary"
            style={{ width: "auto", padding: "7px 20px" }}
            onClick={runPreview}
            disabled={!canPreview}
            title={needsBox ? "부분 모드 이미지에 박스를 그려주세요" : undefined}
          >
            미리보기 ({assignments.length}개)
          </button>
        </div>

        <div className="ocr-assign-list">
          {assignments.map((a, i) => (
            <ModeSelector
              key={a.image.path}
              index={i}
              assignment={a}
              onChange={updated =>
                setAssignments(prev => prev.map((x, j) => j === i ? updated : x))
              }
            />
          ))}
        </div>
      </div>
    );
  }

  // ── Review stage ────────────────────────────────────────────────────────────
  if (stage === "review") {
    return (
      <div className="ocr-tab">
        <div className="ocr-topbar">
          <button className="tbox-btn tbox-btn--ghost" onClick={() => setStage("assign")}>
            ← 다시 지정
          </button>
          <button
            className="tbox-btn tbox-btn--primary"
            style={{ width: "auto", padding: "7px 20px" }}
            onClick={runBuild}
          >
            MD 생성
          </button>
        </div>

        <div className="ocr-review-list">
          {regions.map(r => (
            <RegionPreview key={r.id} region={r} onChange={updateRegion} />
          ))}
        </div>
      </div>
    );
  }

  // ── Done stage ──────────────────────────────────────────────────────────────
  if (stage === "done" && done) {
    const openFolder = () => {
      const dir = done.outPath.replace(/\\/g, "/").split("/").slice(0, -1).join("\\");
      void openPath(dir || ".");
    };
    return (
      <div className="ocr-tab">
        <div className="tbox-placeholder">
          <div className="tbox-placeholder__icon">✅</div>
          <h3>MD 생성 완료</h3>
          <p>텍스트 {done.textCount}개 · 그림 {done.figureCount}개 처리됨</p>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button className="tbox-btn tbox-btn--ghost" onClick={openFolder}>
              📂 폴더 열기
            </button>
            <button className="tbox-btn tbox-btn--ghost" onClick={() => setStage("select")}>
              새 파일 처리
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
