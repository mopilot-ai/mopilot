// The address bar's suggestions as the user types: bookmarks and visited pages from main, fetched after a short pause, the newest answer only, with the highlighted row.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native, type BrowserSuggestion } from './native';
import { noteIgnored } from './ignored';

/** How long typing pauses before main is asked. */
export const SUGGEST_DELAY_MS = 80;

/**
 * @param text what is in the address bar
 * @param active whether the user is typing in it (suggestions are for typed text, never for a page's own address)
 */
export function useSuggestions(text: string, active: boolean) {
  const [items, setItems] = useState<BrowserSuggestion[]>([]);
  const [index, setIndex] = useState(-1);
  const latest = useRef(0);
  useEffect(() => {
    const mine = ++latest.current;
    if (!active || !text.trim()) {
      setItems([]);
      setIndex(-1);
      return;
    }
    const timer = setTimeout(async () => {
      let rows: BrowserSuggestion[] = [];
      try {
        rows = await native.browser.suggest(text);
      } catch (e) {
        noteIgnored('ask for address bar suggestions', e);
      }
      // a later keystroke already asked again
      if (latest.current !== mine) return;
      setItems(rows);
      setIndex(-1);
    }, SUGGEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, active]);
  /** Moves the highlight by one row, wrapping through "none" (-1) so the typed text can be submitted as it is. */
  const move = useCallback(
    (delta: number) => setIndex((i) => ((i + 1 + delta + items.length + 1) % (items.length + 1)) - 1),
    [items.length],
  );
  const drop = useCallback((url: string) => setItems((rows) => rows.filter((r) => r.url !== url)), []);
  return { items, index, setIndex, move, drop };
}
