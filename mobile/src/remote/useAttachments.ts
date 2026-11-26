// Holds a message's attachments: each picked file uploads on its own with progress, cancel, retry and remove; with a `memoryKey` they outlive the screen's rebuild for a new connection (a send or a removal forgets them), and without one nothing does.
import { useCallback, useEffect, useRef, useState } from 'react';
import { explain, type Owned } from './client';
import { INTERRUPTED, recall, remember, streamsOf } from './attachmentMemory';
import {
  Cancelled,
  cancellable,
  computerAway,
  connectionLost,
  OtherComputer,
  partOutcome,
  upload,
  type Picked,
  type Resume,
} from './upload';
import { perf, type UploadNote, type UploadPart } from '../perfLog';

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
/** A chunk the connection lost is sent again by itself after these waits (the app back from the background, a reconnect); only then is the person asked to Retry. */
export const uploadRetry = { waits: [1000, 2000, 4000, 8000, 15000] };

/** What a screen starts with: the items kept for it, an upload a rebuild cut off carrying on (and which those are). Pure, so a second call changes nothing. */
function recalled(memoryKey: string | undefined): { items: Item[]; cutOff: number[] } {
  const items = (memoryKey ? recall(memoryKey) : []).map((item) =>
    item.state === 'failed' && item.error === INTERRUPTED ? { ...item, state: 'sending' as const, error: null } : item,
  );
  const was = memoryKey ? recall(memoryKey) : [];
  return { items, cutOff: was.filter((item) => item.state === 'failed' && item.error === INTERRUPTED).map((item) => item.key) };
}

export function useAttachments(request: Owned, memoryKey?: string) {
  // an upload the screen's rebuild for a new connection cut off carries on by itself here (the connection is why the screen was rebuilt)
  const [start] = useState(() => recalled(memoryKey));
  const [items, setItems] = useState<Item[]>(start.items);
  // the newest request for this computer: an upload outlives the connection it began on
  const latest = useRef(request);
  latest.current = request;
  const controllers = useRef(new Map<number, AbortController>());
  // kept with the items: a rebuilt screen carries on the same stream from the part the Mac confirmed
  const resumes = useRef(memoryKey ? streamsOf(memoryKey) : new Map<number, Resume>());
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
    // `underWay`: an upload a rebuild cut off, carrying on; like one that has confirmed parts, it waits out a computer that is not back yet
    async (key: number, file: Picked, underWay = false) => {
      const controller = new AbortController();
      controllers.current.set(key, controller);
      // a retry carries on from the part the Mac confirmed
      const resume = resumes.current.get(key) ?? { stream: null, next: 0 };
      resumes.current.set(key, resume);
      patch(key, { state: 'sending', sent: resume.next, error: null });
      // the computer this upload is for: a newer request (a reconnect) is taken only while it names the same one
      const computer = latest.current.pair;
      // what the performance log is told of this upload: each part as it went, the waits, and how it ended
      const began = Date.now();
      const note: UploadNote = {
        restarted: underWay,
        computer: computer ? 'named' : 'none',
        parts: 0,
        events: [],
        waits: [],
        result: 'retry',
        reason: null,
        seconds: 0,
      };
      const went = (part: Omit<UploadPart, 'outcome' | 'code'>, ended: { outcome: string; code?: string }) => {
        const before = note.events.at(-1);
        // a part that went right after one that went on the same connection, to the same computer, extends its range
        if (
          ended.outcome === 'ok' &&
          before?.outcome === 'ok' &&
          before.gen === part.gen &&
          before.computer === part.computer &&
          (before.to ?? before.index) + 1 === part.index
        )
          before.to = part.index;
        else note.events.push({ ...part, ...ended });
      };
      const progress = (sent: number, total: number) => {
        note.parts = total;
        patch(key, { sent, total });
      };
      // every part is asked for with its index (sendChunks)
      const request = (async (method: string, params: Record<string, unknown>) => {
        const now = latest.current;
        const part = {
          index: Number(params.index),
          gen: now.generation ?? null,
          computer: now.pair === computer ? ('same' as const) : now.pair ? ('other' as const) : ('none' as const),
        };
        if (now.pair !== computer) {
          went(part, { outcome: 'other-computer' });
          throw new OtherComputer();
        }
        try {
          const reply = await now(method, params);
          went(part, { outcome: 'ok' });
          return reply;
        } catch (e) {
          went(part, partOutcome(e));
          throw e;
        }
      }) as Owned;
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            const done = await upload(request, file, progress, controller.signal, resume);
            resumes.current.delete(key);
            patch(key, { state: 'done', id: done.id });
            note.result = 'done';
            return;
          } catch (e) {
            const wait = uploadRetry.waits[attempt];
            // a fresh pick for a computer that is away fails at once and says so; one under way waits for it to come back
            const passing = connectionLost(e) || ((underWay || resume.next > 0) && computerAway(e));
            if (e instanceof Cancelled || e instanceof OtherComputer || wait === undefined || !passing) throw e;
            note.waits.push(wait);
            await cancellable(new Promise((resolve) => setTimeout(resolve, wait)), controller.signal);
          }
        }
      } catch (e) {
        if (e instanceof Cancelled) patch(key, { state: 'cancelled' });
        else patch(key, { state: 'failed', error: explain(e) });
        // the screen went under it (a rebuild for a new connection), the person cancelled, or the tile now shows Retry, and why
        note.result = e instanceof Cancelled ? (alive.current ? 'cancelled' : 'cut-off') : 'retry';
        const why = partOutcome(e);
        note.reason = e instanceof Cancelled ? null : `${why.outcome}${why.code ? ` ${why.code}` : ''}`;
      } finally {
        controllers.current.delete(key);
        note.seconds = Math.round((Date.now() - began) / 100) / 10;
        perf.upload(note);
      }
    },
    [patch],
  );
  // once: `send` and `start` never change for a screen
  useEffect(() => {
    for (const item of start.items) if (start.cutOff.includes(item.key)) void send(item.key, item.file, true);
  }, [send, start]);
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
