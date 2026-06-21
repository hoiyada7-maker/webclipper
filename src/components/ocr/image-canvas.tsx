import { useCallback, useRef, useState } from "react";
import type { Box2D } from "@/lib/invoke";

interface Props {
  imgUri: string;
  imgNaturalSize: { w: number; h: number };
  bbox: Box2D | null;
  onDraw: (bbox: Box2D) => void;
}

export function ImageCanvas({ imgUri, imgNaturalSize, bbox, onDraw }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null);

  const getRect = () => containerRef.current?.getBoundingClientRect();

  // display px → image natural px
  const toPixel = useCallback(
    (cx: number, cy: number, cw: number, ch: number) => ({
      x: cx * imgNaturalSize.w / cw,
      y: cy * imgNaturalSize.h / ch,
    }),
    [imgNaturalSize],
  );

  // image natural px → display px
  const toDisplay = useCallback(
    (b: Box2D, cw: number, ch: number) => ({
      x: b.x * cw / imgNaturalSize.w,
      y: b.y * ch / imgNaturalSize.h,
      w: b.w * cw / imgNaturalSize.w,
      h: b.h * ch / imgNaturalSize.h,
    }),
    [imgNaturalSize],
  );

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const rect = getRect(); if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    setDrawing({ sx, sy, ex: sx, ey: sy });
    e.preventDefault();
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drawing) return;
    const rect = getRect(); if (!rect) return;
    setDrawing(d => d ? { ...d, ex: e.clientX - rect.left, ey: e.clientY - rect.top } : null);
  }, [drawing]);

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (!drawing) return;
    const rect = getRect(); if (!rect) return;
    const ex = e.clientX - rect.left;
    const ey = e.clientY - rect.top;
    if (Math.abs(ex - drawing.sx) > 6 && Math.abs(ey - drawing.sy) > 6) {
      const { width: cw, height: ch } = rect;
      const p0 = toPixel(Math.min(drawing.sx, ex), Math.min(drawing.sy, ey), cw, ch);
      const p1 = toPixel(Math.max(drawing.sx, ex), Math.max(drawing.sy, ey), cw, ch);
      onDraw({ x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y });
    }
    setDrawing(null);
  }, [drawing, toPixel, onDraw]);

  const rect = containerRef.current?.getBoundingClientRect();
  const cw = rect?.width ?? imgNaturalSize.w;
  const ch = rect?.height ?? imgNaturalSize.h;

  return (
    <div
      ref={containerRef}
      className="ocr-canvas"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => setDrawing(null)}
      style={{ cursor: "crosshair", userSelect: "none" }}
    >
      <img src={imgUri} className="ocr-canvas__img" draggable={false} alt="source" />
      <svg className="ocr-canvas__svg">
        {bbox && (() => {
          const d = toDisplay(bbox, cw, ch);
          return (
            <rect
              x={d.x} y={d.y} width={d.w} height={d.h}
              fill="rgba(96,165,250,0.18)" stroke="#60a5fa" strokeWidth={2}
            />
          );
        })()}
        {drawing && (
          <rect
            x={Math.min(drawing.sx, drawing.ex)} y={Math.min(drawing.sy, drawing.ey)}
            width={Math.abs(drawing.ex - drawing.sx)} height={Math.abs(drawing.ey - drawing.sy)}
            fill="rgba(96,165,250,0.10)" stroke="rgba(96,165,250,0.85)"
            strokeWidth={1.5} strokeDasharray="5 3"
          />
        )}
      </svg>
    </div>
  );
}
