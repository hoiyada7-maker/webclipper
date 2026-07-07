import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { EmbedTab } from "@/components/embed/embed-tab";
import { ExtractTab } from "@/components/extract/extract-tab";
import { OcrTab } from "@/components/ocr/ocr-tab";
import { PdfTab } from "@/components/pdf/pdf-tab";
import { Toast } from "@/components/overlays/toast";
import { cycleTheme, getCurrentTheme, THEMES, type Theme } from "@/lib/theme";
import { cmdIsOcrAvailable, cmdIsPdfAvailable } from "@/lib/invoke";
import "./app.css";

type Tab = "embed" | "extract" | "ocr" | "pdf";

const THEME_ICONS: Record<Theme, string> = {
  mocha: "🌙", latte: "☀️", macchiato: "☕", frappe: "🌥️",
  kanagawa: "🌊", ayu: "🌅", "rose-pine": "🌸", claude: "✨",
  codex: "💻", matcha: "🍵",
};

const WORKDIR_KEY = "md-toolbox-workdir";

export function App() {
  const [tab, setTab] = useState<Tab>("embed");
  const [toast, setToast] = useState<{ msg: string; variant: "error" | "success" } | null>(null);
  const [theme, setTheme] = useState<Theme>(getCurrentTheme);
  const [workDir, setWorkDir] = useState<string>(() => localStorage.getItem(WORKDIR_KEY) ?? "");
  const [hasOcr, setHasOcr] = useState(false);
  const [hasPdf, setHasPdf] = useState(false);

  useEffect(() => {
    void cmdIsOcrAvailable().then(setHasOcr);
    void cmdIsPdfAvailable().then(setHasPdf);
  }, []);

  const showToast = (msg: string, variant: "error" | "success" = "success") => {
    setToast({ msg, variant });
  };

  const handleCycleTheme = () => {
    setTheme(cycleTheme());
  };

  const pickWorkDir = async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir === "string" && dir) {
      setWorkDir(dir);
      localStorage.setItem(WORKDIR_KEY, dir);
    }
  };

  const openWorkDir = async () => {
    if (!workDir) { void pickWorkDir(); return; }
    try { await openPath(workDir); } catch { /* ignore */ }
  };

  const folderName = workDir
    ? workDir.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? workDir
    : "";

  return (
    <div className="tbox-app">
      {/* Left nav */}
      <nav className="tbox-nav">
        <div className="tbox-nav__brand">MD Toolbox</div>
        <div className="tbox-nav__tabs">
          <button
            className={`tbox-nav__btn${tab === "embed" ? " is-active" : ""}`}
            onClick={() => setTab("embed")}
          >
            📎 Embed
          </button>
          <button
            className={`tbox-nav__btn${tab === "extract" ? " is-active" : ""}`}
            onClick={() => setTab("extract")}
          >
            🖼️ Extract
          </button>
          {hasOcr && (
            <button
              className={`tbox-nav__btn${tab === "ocr" ? " is-active" : ""}`}
              onClick={() => setTab("ocr")}
            >
              ✨ OCR Studio
            </button>
          )}
          {hasPdf && (
            <button
              className={`tbox-nav__btn${tab === "pdf" ? " is-active" : ""}`}
              onClick={() => setTab("pdf")}
            >
              📄 PDF
            </button>
          )}
        </div>
        <div className="tbox-nav__footer">
          {/* 저장 경로 위젯 */}
          <div className="tbox-workdir">
            <div className="tbox-workdir__label">저장 경로</div>
            <div className="tbox-workdir__row">
              <button
                className={`tbox-workdir__path${!workDir ? " tbox-workdir__path--empty" : ""}`}
                onClick={openWorkDir}
                title={workDir || undefined}
              >
                {workDir ? `📁 ${folderName}` : "📁 미설정"}
              </button>
              <button className="tbox-workdir__change" onClick={pickWorkDir}>변경</button>
            </div>
          </div>
          <div className="tbox-nav__divider" />
          <button className="tbox-nav__theme-btn" onClick={handleCycleTheme}>
            <span>{THEME_ICONS[theme] ?? "🎨"}</span>
            <span>{theme}</span>
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main className="tbox-main">
        {tab === "embed" && <EmbedTab onToast={showToast} workDir={workDir || undefined} />}
        {tab === "extract" && <ExtractTab onToast={showToast} workDir={workDir || undefined} />}
        {tab === "ocr" && hasOcr && <OcrTab onToast={showToast} workDir={workDir || undefined} />}
        {tab === "pdf" && hasPdf && <PdfTab onToast={showToast} workDir={workDir || undefined} />}
      </main>

      {toast && (
        <Toast
          message={toast.msg}
          variant={toast.variant}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
