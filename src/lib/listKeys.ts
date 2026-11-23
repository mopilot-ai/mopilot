// Stable React keys for list items that carry no id of their own: the item's content plus how many equal items came first.
import { useRef } from 'react';

/** One list item with its key and its position in the list it came from. */
export interface Keyed<T> {
  key: string;
  item: T;
  index: number;
}

/**
 * Pairs each item with a key built from `keyOf(item)` and the number of earlier items with the same content, so a
 * row keeps its key when rows before it are inserted or removed. An index key would pass to the next row instead,
 * and the row's focus, state and animation would move with it (docs/bug-prevention/identity-collisions.md).
 * Use it only for items that truly have no id; prefer the item's own id when it has one.
 */
export function withKeys<T>(items: readonly T[], keyOf: (item: T) => string): Keyed<T>[] {
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const content = keyOf(item);
    const nth = seen.get(content) ?? 0;
    seen.set(content, nth + 1);
    // the count goes first and holds no ':', so two different (count, content) pairs never make one key
    return { key: `${nth}:${content}`, item, index };
  });
}

/**
 * A short stand-in for a long value in a key (an image's data: URL), so a render doesn't compare megabytes: its
 * length and its start (an image's header, with its size). withKeys still tells equal stand-ins apart.
 */
export const fingerprint = (value: string) => (value.length > 160 ? `${value.length}:${value.slice(0, 120)}` : value);

/**
 * Ids for the rows of a list edited in place (an input per row), kept beside the values. Removing a row through
 * `remove` drops its id, so the rows after it keep their own inputs, focus and undo history; with index keys the
 * removed row's input would show the next row's text instead. Rows added at the end, or a list replaced by a longer
 * one, get new ids; a shorter list drops ids from the end.
 */
export function useRowIds(length: number): { ids: readonly string[]; remove: (index: number) => void } {
  const ids = useRef<string[]>([]);
  const made = useRef(0);
  const list = ids.current;
  // repeating a render (Strict Mode) finds the list already the right length
  while (list.length < length) list.push(`row-${++made.current}`);
  list.length = length;
  return { ids: list, remove: (index) => void list.splice(index, 1) };
}
