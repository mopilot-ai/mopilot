// Holds a message's attachments: each picked file uploads on its own with progress, cancel, retry and remove; with a `memoryKey` they outlive the screen's rebuild for a new connection (a send or a removal forgets them), and without one nothing does.
import { useCallback, useEffect, useRef, useState } from 'react';
import { explain, type Owned } from './client';
import { recall, remember } from './attachmentMemory';
import { Cancelled, upload, type Picked, type Resume } from './upload';

export type Item = {
  key: number;
  file: Picked;
  state: 'sending' | 'done' | 'failed' | 'cancelled';
  sent: number;
  total: number;
  id: string | null;
  error: string | null;
};
/** A message carries at most 10 files (the Mac's limit). */
export const MAX_FILES = 10;

export function useAttachments(request: Owned, memoryKey?: string) {
  const [items, setItems] = useState<Item[]>(() => (memoryKey ? recall(memoryKey) : []));
  const controllers = useRef(new Map<number, AbortController>());
  const resumes = useRef(new Map<number, Resume>());
  const next = useRef(items.reduce((top, i) => Math.max(top, i.key + 1), 0));
  useEffect(() => {
    if (memoryKey) remember(memoryKey, items);
  }, [memoryKey, items]);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      for (const c of controllers.current.values()) c.abort();
    },
    [],
  );
  const patch = useCallback((key: number, change: Partial<Item>) => {
    if (alive.current) setItems((old) => old.map((i) => (i.key === key ? { ...i, ...change } : i)));
  }, []);
  const send = useCallback(
    async (key: number, file: Picked) => {
      const controller = new AbortController();
      controllers.current.set(key, controller);
      // a retry carries on from the part the Mac confirmed
      const resume = resumes.current.get(key) ?? { stream: null, next: 0 };
      resumes.current.set(key, resume);
      patch(key, { state: 'sending', sent: resume.next, error: null });
      try {
        const done = await upload(request, file, (sent, total) => patch(key, { sent, total }), controller.signal, resume);
        resumes.current.delete(key);
        patch(key, { state: 'done', id: done.id });
      } catch (e) {
        if (e instanceof Cancelled) patch(key, { state: 'cancelled' });
        else patch(key, { state: 'failed', error: explain(e) });
      } finally {
        controllers.current.delete(key);
      }
    },
    [request, patch],
  );
  const add = useCallback(
    (file: Picked) => {
      const key = next.current++;
      setItems((old) => [...old, { key, file, state: 'sending', sent: 0, total: 1, id: null, error: null }]);
      void send(key, file);
    },
    [send],
  );
  const retry = useCallback(
    (key: number) => {
      const item = items.find((i) => i.key === key);
      if (item && (item.state === 'failed' || item.state === 'cancelled')) void send(key, item.file);
    },
    [items, send],
  );
  const cancel = useCallback((key: number) => controllers.current.get(key)?.abort(), []);
  const remove = useCallback((key: number) => {
    controllers.current.get(key)?.abort();
    resumes.current.delete(key);
    setItems((old) => old.filter((i) => i.key !== key));
  }, []);
  const clear = useCallback(() => setItems([]), []);
  const ids = items.flatMap((i) => (i.state === 'done' && i.id ? [i.id] : []));
  return {
    items,
    add,
    retry,
    cancel,
    remove,
    clear,
    ids,
    sending: items.some((i) => i.state === 'sending'),
    full: items.length >= MAX_FILES,
  };
}
