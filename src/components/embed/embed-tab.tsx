import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { cmdEmbedImages, type EmbedResult } from "@/lib/invoke";

type FileItem = {
  path: string;
  status: "idle" | "ok" | "error";
  result: EmbedResult | null;
  error: string | null;
};

type Props = {
  onToast: (msg: string, variant?: "error" | "success") => void;
  workDir?: string;
};

export function EmbedTab({ onToast, workDir }: Props) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragCountRef = useRef(0);

  const addFiles = useCallback((paths: string[]) => {
    const mdPaths = paths.filter(p => p.toLowerCase().endsWith(".md"));
    if (!mdPaths.length) return;
    setFiles(prev => {
      const existing = new Set(prev.map(f => f.path));
      const newItems: FileItem[] = mdPaths
        .filter(p => !existing.has(p))
        .map(p => ({ path: p, status: "idle", result: null, error: null }));
      return [...prev, ...newItems];
    });
  }, []);

  useEffect(() => {
    let unlistenDrop: (() => void) | undefined;
    let unlistenEnter: (() => void) | undefined;
    let unlistenLeave: (() => void) | undefined;

    void listen<{ paths: string[] }>("tauri://drag-enter", () => {
      dragCountRef.current++;
      setDragOver(true);
    }).then(ul => { unlistenEnter = ul; });

    void listen<{ paths: string[] }>("tauri://drag-drop", e => {
      dragCountRef.current = 0;
      setDragOver(false);
      addFiles(e.payload.paths);
    }).then(ul => { unlistenDrop = ul; });

    void listen("tauri://drag-leave", () => {
      dragCountRef.current = Math.max(0, dragCountRef.current - 1);
      if (dragCountRef.current === 0) setDragOver(false);
    }).then(ul => { unlistenLeave = ul; });

    return () => { unlistenDrop?.(); unlistenEnter?.(); unlistenLeave?.(); };
  }, [addFiles]);

  const pickFile = useCallback(async () => {
    const p = await openDialog({
      filters: [{ name: "Markdown", extensions: ["md"] }],
      multiple: true,
    });
    if (Array.isArray(p)) addFiles(p);
    else if (typeof p === "string") addFiles([p]);
  }, [addFiles]);

  const removeFile = useCallback((path: string) => {
    setFiles(prev => prev.filter(f => f.path !== path));
  }, []);

  const run = useCallback(async () => {
    const pending = files.filter(f => f.status !== "ok");
    if (!pending.length) return;
    setLoading(true);
    let totalImages = 0;
    let errCount = 0;

    for (const file of pending) {
      try {
        const r = await cmdEmbedImages(file.path, workDir || undefined);
        totalImages += r.img_count;
        setFiles(prev => prev.map(f =>
          f.path === file.path ? { ...f, status: "ok", result: r, error: null } : f
        ));
      } catch (e) {
        errCount++;
        setFiles(prev => prev.map(f =>
          f.path === file.path ? { ...f, status: "error", error: String(e), result: null } : f
        ));
      }
    }

    setLoading(false);
    if (errCount === 0) {
      onToast(`${pending.length}개 파일, ${totalImages}개 이미지 임베드 완료`, "success");
    } else {
      onToast(`${pending.length - errCount}개 성공, ${errCount}개 실패`, "error");
    }
  }, [files, workDir, onToast]);

  const openFolder = useCallback(async (filePath: string) => {
    const sep = filePath.includes("\\") ? "\\" : "/";
    const dir = filePath.substring(0, filePath.lastIndexOf(sep));
    try { await openPath(dir); } catch { /* ignore */ }
  }, []);

  const hasFiles = files.length > 0;
  const pendingCount = files.filter(f => f.status !== "ok").length;

  return (
    <div className="tbox-tab">
      <div className="tbox-tab__header">
        <h2>📎 MD 이미지 Base64 임베드</h2>
        <p className="tbox-tab__desc">
          MD 파일 내 로컬 이미지 경로를 Base64 data URI로 인라인 치환합니다.
          이미지 파일을 <code>./assets/</code> 등 상대경로로 참조하는 MD에 적용하세요.
          <br />
          결과: <code>원본명_embedded.md</code> (같은 폴더에 저장)
        </p>
      </div>

      <div
        className={`tbox-drop tbox-drop--compact${dragOver ? " is-drag-over" : ""}`}
        onClick={pickFile}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === "Enter" && pickFile()}
        aria-label="MD 파일 선택"
      >
        <span className="tbox-drop__icon-lg">📁</span>
        <div className="tbox-drop__compact-text">
          <span>
            {hasFiles
              ? `${files.length}개 파일 선택됨 — 클릭 또는 드래그로 추가`
              : "MD 파일 드래그하거나 클릭해서 선택"}
          </span>
          {!hasFiles && <span className="tbox-drop__hint">.md 파일, 여러 개 가능</span>}
        </div>
      </div>

      {hasFiles && (
        <div className="tbox-filelist">
          {files.map(f => {
            const name = f.path.split(/[\\/]/).pop()!;
            return (
              <div key={f.path} className={`tbox-filelist__item${f.status === "ok" ? " is-ok" : f.status === "error" ? " is-error" : ""}`}>
                <span className="tbox-filelist__icon">
                  {f.status === "ok" ? "✓" : f.status === "error" ? "✗" : "·"}
                </span>
                <div className="tbox-filelist__info">
                  <div className="tbox-filelist__name" title={f.path}>{name}</div>
                  {f.status === "ok" && f.result && (
                    <button
                      className="tbox-filelist__sub tbox-filelist__sub--ok"
                      onClick={() => openFolder(f.result!.out_path)}
                    >
                      {f.result.img_count}개 이미지 → {f.result.out_path.split(/[\\/]/).pop()} 📂
                    </button>
                  )}
                  {f.status === "error" && (
                    <div className="tbox-filelist__sub tbox-filelist__sub--error">{f.error}</div>
                  )}
                </div>
                {!loading && (
                  <button
                    className="tbox-filelist__remove"
                    onClick={e => { e.stopPropagation(); removeFile(f.path); }}
                    aria-label="제거"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {hasFiles && pendingCount > 0 && (
        <button className="tbox-btn tbox-btn--primary" onClick={run} disabled={loading}>
          {loading ? "처리 중..." : `📎 Base64 임베드 실행 (${pendingCount}개)`}
        </button>
      )}
    </div>
  );
}
