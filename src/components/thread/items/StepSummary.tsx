// Step and group screenshots open previews independently of the adjacent detail disclosure.
import { useId, type ReactNode } from 'react';
import { ZoomableImage } from '../../ui/ImageLightbox';
import { ChevronDown } from '../../ui/icons';

/** How many of a row's last screenshots show: Claude Desktop's small strip shows three, one in a narrow window. */
export const THUMBS_SHOWN = 3;

/**
 * Screenshot previews are siblings of the disclosure button, never children of it. The row shows its last three (one
 * when narrow, by CSS), after a "+N" count of the earlier ones, as Claude Desktop's small strip does.
 */
export function StepThumbs({ srcs }: { srcs: string[] }) {
  const all = [...new Set(srcs)];
  if (!all.length) return null;
  const shown = all.slice(-THUMBS_SHOWN);
  const earlier = all.length - shown.length;
  return (
    <span className="step-thumbs">
      {earlier > 0 && <span className="step-thumbs-more wide">+{earlier}</span>}
      {all.length > 1 && <span className="step-thumbs-more narrow">+{all.length - 1}</span>}
      {shown.map((src, i) => (
        <ZoomableImage
          key={src}
          className={`step-thumb${i < shown.length - 1 ? ' step-thumb-wide' : ''}`}
          src={src}
          alt={`Screenshot ${earlier + i + 1}`}
        />
      ))}
    </span>
  );
}

/** A group header keeps the row-sized detail target underneath its independent image controls. */
export function StepSummary({
  open,
  onToggle,
  icon,
  thumbs,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  thumbs: string[];
  children: ReactNode;
}) {
  const textId = useId();
  return (
    <div className="step-row summary">
      <button type="button" className="step-row-hit" aria-expanded={open} aria-labelledby={textId} onClick={onToggle} />
      <span className="step-icon">{icon}</span>
      <span className="step-text" id={textId}>
        {children}
      </span>
      <ChevronDown size={14} className="step-chevron" />
      <StepThumbs srcs={thumbs} />
    </div>
  );
}
