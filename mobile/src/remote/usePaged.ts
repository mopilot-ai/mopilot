// A list the Mac returns a page at a time: appends the next page on demand, keeps what is shown when a page fails, and can reload from the start.
import { useState } from 'react';
import { explain } from './client';

/** One page: what it adds and where the following page starts (null at the end). */
export type Page<T> = { items: T; next: number | null };

export function usePaged<T>(first: Page<T>, more: (from: number) => Promise<Page<T>>, join: (all: T, page: T) => T) {
  const [items, setItems] = useState(first.items);
  const [next, setNext] = useState(first.next);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(from: number, append: boolean) {
    setBusy(true);
    setError(null);
    try {
      const page = await more(from);
      setItems((old) => (append ? join(old, page.items) : page.items));
      setNext(page.next);
    } catch (e) {
      setError(explain(e));
    }
    setBusy(false);
  }
  return {
    items,
    next,
    error,
    busy,
    /** The following page; a failed one can be asked for again. */
    load: () => run(next as number, true),
    /** Everything again from the start, for a list that changed under the reader. */
    reload: () => run(0, false),
  };
}
