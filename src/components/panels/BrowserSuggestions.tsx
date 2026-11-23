// The list under the address bar: bookmarks and visited pages matching what was typed. It is a menu, so the page view hides while it is open (docs/browser.md).
import type { BrowserSuggestion } from '../../lib/native';
import { Star, History } from '../ui/icons';

export function SuggestionList({
  items,
  index,
  onPick,
  onHover,
}: {
  items: BrowserSuggestion[];
  index: number;
  onPick: (url: string) => void;
  onHover: (index: number) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="menu browser-suggest" role="listbox" aria-label="Suggestions">
      {items.map((s, i) => (
        <button
          type="button"
          tabIndex={-1}
          key={`${s.kind}:${s.url}`}
          role="option"
          aria-selected={i === index}
          className={`browser-suggest-row ${i === index ? 'on' : ''}`}
          // the address bar keeps its focus, so a click is not a blur that closes the list first
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(s.url)}
          onMouseMove={() => onHover(i)}
        >
          <span className="browser-suggest-icon">{s.kind === 'bookmark' ? <Star size={13} /> : <History size={13} />}</span>
          <span className="browser-suggest-title">{s.title || s.url}</span>
          <span className="browser-suggest-url">{s.url.replace(/^https?:\/\/(www\.)?/, '')}</span>
        </button>
      ))}
    </div>
  );
}
