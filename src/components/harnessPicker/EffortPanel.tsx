// The model picker's effort panel and the More row that opens it: the effort slider under a head that names the effort and
// the model (back to the model list) with a reset, shared by the composer's model picker and MoMo's brain chip.
import { useRef, type ReactNode, type Ref } from 'react';
import { effortLabel } from '../../lib/format';
import { Tooltip } from '../ui/Popover';
import { MenuRow, useFocusWhileOpen } from '../ui/MenuList';
import { ChevronRight, RotateCcw } from '../ui/icons';

/** The model list's More row: effort (and speed) behind it, with what they are now as its line. */
export function MoreRow({ desc, onClick }: { desc: string; onClick: () => void }) {
  return (
    <MenuRow className="has-desc hp-more-row" aria-haspopup="menu" onClick={onClick}>
      <span className="menu-label">
        <span className="menu-title">More</span>
        <span className="menu-desc">{desc}</span>
      </span>
      <ChevronRight size={13} className="menu-chevron" />
    </MenuRow>
  );
}

export interface EffortPanelProps {
  /** the panel shows: it takes focus, so its arrows and Tab work from the keyboard */
  open: boolean;
  /** the model's effort levels, lowest first */
  efforts: string[];
  effort: string | null;
  /** a level's name; the app's effort names by default */
  labelOf?: (effort: string) => string;
  /** what the panel says without effort levels */
  noEffort: string;
  onEffort: (effort: string) => void;
  /** back to the model's default effort; none: the model names no default */
  onReset?: () => void;
  /** the head's title row: back to the model list (MoMo), or the harness list it opens (the composer's picker) */
  onBack: () => void;
  /** the title row, when it anchors a list it opens */
  titleRef?: Ref<HTMLButtonElement>;
  /** that list is open (the title row is then a menu button); none: the row only goes back */
  titleExpanded?: boolean;
  /** the head's model line (harness icon, provider, model); one line, truncated with an ellipsis */
  model: ReactNode;
  /** the model line in full: with it the line is one line, truncated with an ellipsis, and this is its tooltip; without it the line is as it always was */
  modelTitle?: string;
  /** what the head and the slider say while a model with levels has none chosen (a machine whose Host reports no default effort): no knob on any level. Without it that state is the first level, as it always was. */
  unsetLabel?: string;
  /** the head's left button (fast mode); an empty slot by default */
  lead?: ReactNode;
  /** below the slider: speed tiers, notes, the account row */
  children?: ReactNode;
}

export function EffortPanel(p: EffortPanelProps) {
  // no effort picked: no name, as effortLabel has none for it
  const name = (e: string) => (e ? (p.labelOf ?? effortLabel)(e) : '');
  const { efforts } = p;
  const pop = useRef<HTMLDivElement>(null);
  useFocusWhileOpen(pop, p.open);
  // -1: no level chosen yet and the caller says so (`unsetLabel`), so the slider has no knob on any of them;
  // otherwise a level the model does not list counts as its first
  const unset = p.unsetLabel !== undefined && !p.effort;
  const ei = unset ? -1 : Math.max(0, efforts.indexOf(p.effort ?? ''));
  const setIdx = (i: number) => {
    const e = efforts[Math.max(0, Math.min(efforts.length - 1, i))];
    // a drag over the same level, or an arrow at either end, changes nothing
    if (e && e !== p.effort) p.onEffort(e);
  };
  const trackRef = useRef<HTMLDivElement>(null);
  const fromPointer = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    setIdx(Math.round(((clientX - r.left - 14) / (r.width - 28)) * (efforts.length - 1)));
  };
  return (
    <div
      ref={pop}
      className="menu effort-pop hp-pop"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setIdx(ei - 1);
        if (e.key === 'ArrowRight') setIdx(ei + 1);
      }}
    >
      <div className="effort-head">
        {p.lead ?? <span className="effort-icon-btn" aria-hidden />}
        <button
          type="button"
          ref={p.titleRef}
          className={`effort-title${p.titleExpanded ? ' open' : ''}`}
          onClick={p.onBack}
          aria-haspopup={p.titleExpanded === undefined ? undefined : 'menu'}
          aria-expanded={p.titleExpanded}
          aria-label="Select harness and model"
        >
          <span className="effort-name">{efforts.length ? (unset ? p.unsetLabel : name(p.effort ?? '')) : 'Default'}</span>
          <span className="effort-model">
            {p.modelTitle === undefined ? (
              p.model
            ) : (
              <span className="effort-model-text" title={p.modelTitle}>
                {p.model}
              </span>
            )}{' '}
            <ChevronRight size={12} />
          </span>
        </button>
        {p.onReset ? (
          <Tooltip label="Reset to default">
            <button className="effort-icon-btn" onClick={p.onReset} aria-label="Reset to default">
              <RotateCcw size={16} strokeWidth={1.7} />
            </button>
          </Tooltip>
        ) : (
          <span className="effort-icon-btn" aria-hidden />
        )}
      </div>
      {efforts.length > 1 ? (
        <div
          className="effort-track"
          ref={trackRef}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            fromPointer(e.clientX);
          }}
          onPointerMove={(e) => e.buttons && fromPointer(e.clientX)}
          role="slider"
          aria-label="Effort"
          aria-valuenow={unset ? undefined : ei}
          aria-valuetext={unset ? p.unsetLabel : undefined}
        >
          {ei >= 0 && <div className="effort-fill" style={{ width: `calc(${ei / (efforts.length - 1)} * (100% - 28px) + 28px)` }} />}
          {efforts.map((e, i) => (
            <span key={e} className="effort-dot" style={{ left: `calc(${i / (efforts.length - 1)} * (100% - 28px) + 14px)` }} />
          ))}
          {ei >= 0 && <span className="effort-knob" style={{ left: `calc(${ei / (efforts.length - 1)} * (100% - 28px))` }} />}
        </div>
      ) : (
        <div className="hp-no-effort">{p.noEffort}</div>
      )}
      {p.children}
    </div>
  );
}
