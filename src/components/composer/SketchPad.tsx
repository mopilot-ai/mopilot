// The composer's local drawing canvas produces a PNG and keeps its drawing when attachment admission refuses.
import { useEffect, useRef, useState } from 'react';
import { SKETCH } from '../../lib/brandColors';
import { Eraser } from '../ui/icons';

/** "Sketch": a small drawing pad; the drawing is attached to the message as a PNG. */
export function SketchPad({ onClose, onInsert }: { onClose: () => void; onInsert: (dataUrl: string) => Promise<boolean> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState<string>(SKETCH.ink);
  const [width, setWidth] = useState(3);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = SKETCH.paper;
    ctx.fillRect(0, 0, c.width, c.height);
  }, []);
  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * ref.current!.width) / r.width, y: ((e.clientY - r.top) * ref.current!.height) / r.height };
  };
  const line = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const ctx = ref.current!.getContext('2d')!;
    ctx.strokeStyle = color;
    ctx.lineWidth = color === SKETCH.paper ? width * 6 : width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };
  return (
    <div className="sketch-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sketch">
        <div className="sketch-head">
          <span>Sketch</span>
          <div className="sketch-tools">
            {SKETCH.pens.map((c) => (
              <button
                key={c}
                className={`sketch-color ${color === c ? 'on' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`Color ${c}`}
              />
            ))}
            <button
              className={`sketch-tool ${color === SKETCH.paper ? 'on' : ''}`}
              onClick={() => setColor(SKETCH.paper)}
              aria-label="Eraser"
            >
              <Eraser size={15} />
            </button>
            <input
              type="range"
              min={1}
              max={12}
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
              aria-label="Stroke width"
            />
            <button
              className="sketch-tool"
              onClick={() => {
                const c = ref.current!;
                const ctx = c.getContext('2d')!;
                ctx.fillStyle = SKETCH.paper;
                ctx.fillRect(0, 0, c.width, c.height);
              }}
            >
              Clear
            </button>
          </div>
        </div>
        <canvas
          ref={ref}
          width={1200}
          height={760}
          className="sketch-canvas"
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture(e.pointerId);
            drawing.current = pos(e);
            line(drawing.current, drawing.current);
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const p = pos(e);
            line(drawing.current, p);
            drawing.current = p;
          }}
          onPointerUp={() => (drawing.current = null)}
        />
        <div className="sketch-foot">
          <button className="btn-pill" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-white"
            onClick={async () => {
              if (await onInsert(ref.current!.toDataURL('image/png'))) onClose();
            }}
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}
