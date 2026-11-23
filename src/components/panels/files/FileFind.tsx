// The Files pane's bars over a file's code: find in file (⌘F), its matches highlighted and Enter / ⇧Enter between them, and go to line (⌃G).
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react';
import { foldTerm, stepMatch } from '../../../lib/textFind';
import { showFindHighlights, textRanges } from '../../thread/view/chatFindRanges';
import { useEffectOn } from '../../../lib/effects';
import { ChevronDown, ChevronUp, Search, X } from '../../ui/icons';

/**
 * Find in the code under `root`: every match highlighted, the current one set apart and scrolled into view. `version`
 * changes whenever the code is drawn again (another highlight, wrapping), so the ranges are read again.
 */
export function FileFindBar({
  root,
  version,
  focusKey,
  onClose,
}: {
  root: RefObject<HTMLElement | null>;
  version: unknown;
  /** changes each time find is asked for again while open: the field takes focus and selects its term */
  focusKey: number;
  onClose: () => void;
}) {
  const [term, setTerm] = useState('');
  const needle = foldTerm(term);
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const owner = useRef({});
  const reveal = useRef(false);
  const paint = useEffectEvent(() => {
    // the bar shows only over drawn code, so the code's element is there by the time effects run
    const ranges = textRanges(root.current!, needle);
    if (ranges.length !== count) setCount(ranges.length);
    const at = ranges.length ? Math.min(index, ranges.length - 1) : -1;
    const current = at >= 0 ? ranges[at] : null;
    showFindHighlights(owner.current, needle ? { all: ranges, current } : null);
    if (!current || !reveal.current) return;
    reveal.current = false;
    current.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
  // a new term starts at its first match
  useEffectOn([needle], () => {
    setIndex(0);
    reveal.current = true;
  });
  // paint again for a new term, another current match, or code drawn again
  useEffectOn([needle, index, version], () => {
    paint();
  });
  useEffect(() => () => showFindHighlights(owner.current, null), []);
  useEffectOn([focusKey], () => {
    input.current?.focus();
    input.current?.select();
  });
  const step = (by: 1 | -1) => {
    setIndex((i) => Math.max(stepMatch(count, Math.min(i, count - 1), by), 0));
    reveal.current = true;
  };
  return (
    <div className="chat-find file-find" role="search">
      <Search size={14} className="chat-find-icon" aria-hidden="true" />
      <input
        ref={input}
        className="chat-find-input"
        aria-label="Find in file"
        placeholder="Find in file"
        value={term}
        spellCheck={false}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="chat-find-count" aria-live="polite">
        {needle ? (count ? `${Math.min(index, count - 1) + 1} of ${count}` : 'No results') : ''}
      </span>
      <button type="button" className="icon-btn xs" aria-label="Previous match" disabled={!count} onClick={() => step(-1)}>
        <ChevronUp size={14} />
      </button>
      <button type="button" className="icon-btn xs" aria-label="Next match" disabled={!count} onClick={() => step(1)}>
        <ChevronDown size={14} />
      </button>
      <button type="button" className="icon-btn xs" aria-label="Close find" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}

/** Go to a line of the file (1 to `lines`): Enter goes there, a number out of range says which lines there are. */
export function GoToLineBar({ lines, onGo, onClose }: { lines: number; onGo: (line: number) => void; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div className="chat-find file-find" role="search">
      <input
        ref={input}
        className="chat-find-input"
        aria-label="Go to line"
        placeholder={`Go to line (1–${lines})`}
        inputMode="numeric"
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const line = Number(value.trim());
            if (Number.isInteger(line) && line >= 1 && line <= lines) onGo(line);
            else setInvalid(true);
          }
        }}
      />
      <span className="chat-find-count" aria-live="polite">
        {invalid ? `Lines 1–${lines}` : ''}
      </span>
      <button type="button" className="icon-btn xs" aria-label="Close go to line bar" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}
