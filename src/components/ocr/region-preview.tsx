import { useState } from "react";
import { cmdOcrText, type Box2D, type Region } from "@/lib/invoke";

interface Props {
  region: Region;
  onChange: (r: Region) => void;
}

export function RegionPreview({ region, onChange }: Props) {
  const [reOcrLoading, setReOcrLoading] = useState(false);

  const runReOcr = async () => {
    setReOcrLoading(true);
    try {
      const bbox: Box2D | undefined = region.bbox.full
        ? undefined
        : { x: region.bbox.x, y: region.bbox.y, w: region.bbox.w, h: region.bbox.h };
      const text = await cmdOcrText(region.imgPath, bbox);
      onChange({ ...region, ocrText: text });
    } catch {
      // leave text unchanged on error
    } finally {
      setReOcrLoading(false);
    }
  };

  const toggleType = () => {
    onChange({ ...region, finalType: region.finalType === "text" ? "figure" : "text" });
  };

  const fileName = region.imgPath.replace(/\\/g, "/").split("/").pop() ?? region.imgPath;

  return (
    <div className={`ocr-rp-card${region.finalType === "text" ? " is-text" : " is-figure"}`}>
      <div className="ocr-rp-card__head">
        <span className="ocr-rp-card__name" title={region.imgPath}>{fileName}</span>
        <button
          className={`ocr-rp-card__toggle${region.finalType === "figure" ? " is-figure" : " is-text"}`}
          onClick={toggleType}
          title="클릭해서 텍스트/그림 전환"
        >
          {region.finalType === "text" ? "🔤 텍스트" : "🖼️ 그림"}
        </button>
      </div>

      <div className="ocr-rp-card__body">
        {region.croppedB64 && (
          <img
            src={region.croppedB64}
            className="ocr-rp-card__crop"
            alt="crop preview"
          />
        )}

        {region.finalType === "text" && (
          <div className="ocr-rp-card__text-wrap">
            <textarea
              className="ocr-rp-card__textarea"
              value={region.ocrText}
              onChange={e => onChange({ ...region, ocrText: e.target.value })}
              rows={4}
              placeholder="OCR 텍스트 (직접 편집 가능)"
            />
            <button
              className="tbox-btn tbox-btn--ghost"
              style={{ fontSize: 11, padding: "3px 10px", alignSelf: "flex-start" }}
              onClick={runReOcr}
              disabled={reOcrLoading}
            >
              {reOcrLoading ? "..." : "재OCR"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
