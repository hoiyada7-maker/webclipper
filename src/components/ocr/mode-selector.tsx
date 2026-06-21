import { useEffect, useState } from "react";
import { cmdReadImageB64, type Box2D, type MdImageRef } from "@/lib/invoke";
import { ImageCanvas } from "./image-canvas";

export type AssignMode =
  | "full-figure"
  | "full-text"
  | "partial-figure"
  | "partial-text";

export interface Assignment {
  image: MdImageRef;
  mode: AssignMode;
  bbox: Box2D | null;
}

interface Props {
  index: number;
  assignment: Assignment;
  onChange: (a: Assignment) => void;
}

const MODES: { value: AssignMode; label: string; hint: string }[] = [
  { value: "full-figure",    label: "전체→그림",    hint: "이미지 전체를 PNG로 저장" },
  { value: "full-text",      label: "전체→텍스트",  hint: "이미지 전체를 OCR 텍스트로 대체" },
  { value: "partial-figure", label: "부분→그림",    hint: "드래그 영역을 PNG로 저장" },
  { value: "partial-text",   label: "부분→텍스트",  hint: "드래그 영역을 OCR 텍스트로 대체" },
];

export function ModeSelector({ index, assignment, onChange }: Props) {
  const [imgUri, setImgUri] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState({ w: 1, h: 1 });
  const isPartial = assignment.mode === "partial-figure" || assignment.mode === "partial-text";
  const showThumb = true;
  const fileName = assignment.image.path.replace(/\\/g, "/").split("/").pop() ?? assignment.image.path;

  useEffect(() => {
    void cmdReadImageB64(assignment.image.path).then(setImgUri).catch(() => setImgUri(null));
  }, [assignment.image.path]);

  const setMode = (mode: AssignMode) => {
    const isPartialMode = mode === "partial-figure" || mode === "partial-text";
    onChange({ ...assignment, mode, bbox: isPartialMode ? assignment.bbox : null });
  };

  return (
    <div className="ocr-mode-card">
      <div className="ocr-mode-card__head">
        <span className="ocr-mode-card__idx">{index + 1}</span>
        <span className="ocr-mode-card__name" title={assignment.image.path}>{fileName}</span>
        {assignment.image.alt && (
          <span className="ocr-mode-card__alt">{assignment.image.alt}</span>
        )}
      </div>

      <div className="ocr-mode-card__modes">
        {MODES.map(m => (
          <label
            key={m.value}
            className={`ocr-mode-btn${assignment.mode === m.value ? " is-active" : ""}`}
            title={m.hint}
          >
            <input
              type="radio"
              name={`mode-${index}`}
              checked={assignment.mode === m.value}
              onChange={() => setMode(m.value)}
            />
            {m.label}
          </label>
        ))}
      </div>

      {imgUri && showThumb && (
        <div className="ocr-mode-card__canvas-wrap">
          {isPartial ? (
            <>
              <ImageCanvas
                imgUri={imgUri}
                imgNaturalSize={imgSize}
                bbox={assignment.bbox}
                onDraw={bbox => onChange({ ...assignment, bbox })}
              />
              {assignment.bbox ? (
                <div className="ocr-mode-card__bbox-row">
                  <span className="ocr-mode-card__bbox-info">
                    {Math.round(assignment.bbox.x)},{Math.round(assignment.bbox.y)}
                    {" · "}{Math.round(assignment.bbox.w)}×{Math.round(assignment.bbox.h)}
                  </span>
                  <button
                    className="ocr-mode-card__clear-btn"
                    onClick={() => onChange({ ...assignment, bbox: null })}
                  >
                    지우기
                  </button>
                </div>
              ) : (
                <div className="ocr-mode-card__draw-hint">↖ 드래그로 영역을 지정하세요</div>
              )}
            </>
          ) : (
            <img
              src={imgUri}
              className="ocr-mode-card__thumb"
              alt={assignment.image.alt}
            />
          )}
          <img
            src={imgUri}
            style={{ display: "none" }}
            onLoad={e => {
              const img = e.currentTarget;
              setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            alt=""
          />
        </div>
      )}
    </div>
  );
}
