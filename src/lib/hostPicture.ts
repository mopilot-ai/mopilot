// A picture the user sent to a chat on a machine, read back from it when the message is drawn from history: its data URL once fetched, or why there is none. Fetched pictures are kept for the session; a transient answer (`retry`, or `offline` while the machine reports online) is asked again by itself after each of `RE_ASK_MS`, then left to `retry()`; any other answer is tried again the next time the message is drawn, or at once on `retry()`.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from './native';
import { useHostMachines } from './hostMachines';
import { visiblePoll } from './visiblePoll';
import type { HostPictureReply } from './native/host';

export type HostPicture =
  | { state: 'loading' }
  | { state: 'ready'; url: string }
  | { state: 'offline'; machine: string }
  | { state: 'retry'; machine: string }
  | { state: 'blocked'; machine: string }
  | { state: 'update'; machine: string }
  | { state: 'gone'; machine?: string };

/** What the session keeps of fetched pictures: at most this many, and this many characters of data URL in all (about 40 MB: room for one picture of the Host's largest size, 25 MiB, which is 33.5 million characters). */
const MAX_KEPT = 64;
export const MAX_KEPT_CHARS = 40 * 1024 * 1024;
/** How long a transient answer waits before it is asked again by itself, one wait per re-ask; after the last the picture keeps its Try again. */
export const RE_ASK_MS = [5_000, 15_000, 45_000];
/** How early by the clock a wait may count as over (timers fire a hair before the clock says so). */
const WAIT_SLACK_MS = 50;
const kept = new Map<string, string>();
let keptChars = 0;
const inflight = new Map<string, Promise<HostPictureReply>>();

/** Whether `src` is a Host's own reference to a picture, which only that machine can draw. */
export const isHostPicture = (src: string | undefined): src is string => typeof src === 'string' && src.startsWith('host-image:');

/** One picture's reply, asked of main once at a time. */
function fetchPicture(key: string, chatId: string, src: string): Promise<HostPictureReply> {
  const asked =
    inflight.get(key) ??
    native.host.picture(chatId, src).then(
      (reply) => reply,
      () => ({ gone: true as const }),
    );
  inflight.set(key, asked);
  void asked.then(() => inflight.delete(key));
  return asked;
}

/** Keeps a picture for the session; the oldest go when there are too many or they weigh too much, and one too big to keep alone is shown but not kept. */
function keep(key: string, url: string) {
  if (url.length > MAX_KEPT_CHARS) return;
  keptChars -= kept.get(key)?.length ?? 0;
  kept.set(key, url);
  keptChars += url.length;
  while (kept.size > MAX_KEPT || keptChars > MAX_KEPT_CHARS) {
    const oldest = kept.keys().next().value!;
    keptChars -= kept.get(oldest)!.length;
    kept.delete(oldest);
  }
}

/** The picture a `host-image:` source stands for in a chat: loading, then ready, offline or gone. */
export function useHostPicture(chatId: string, src: string): HostPicture & { retry: () => void; asking: boolean } {
  const key = `${chatId}\n${src}`;
  const [shown, setShown] = useState<HostPicture>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // the automatic re-asks made since the last answer that settled or click; a click starts the waits over
  const [made, setMade] = useState({ key, n: 0 });
  // a picture that is drawn again after another starts its waits from the first
  if (made.key !== key) setMade({ key, n: 0 });
  const auto = made.key === key ? made.n : 0;
  // a re-ask (by itself or by Try again) is in flight: the last transient answer stays on screen meanwhile, and the placeholder is only for a first ask
  const [asking, setAsking] = useState(false);
  const lastTransient = useRef<string | null>(null);
  const retry = useCallback(() => (setMade({ key, n: 0 }), setAttempt((n) => n + 1)), [key]);
  // an offline machine is asked again when one comes back online (any machine: the answer carries only its name)
  const { machines } = useHostMachines();
  const online = machines
    .filter((m) => m.status === 'online')
    .map((m) => m.id)
    .join();
  const offline = shown.state === 'offline';
  const before = useRef(online);
  useEffect(() => {
    // only a machine newly online counts: those already online when the answer came are not the news
    const came = online.split(',').some((id) => id && !before.current.split(',').includes(id));
    before.current = online;
    if (offline && came) retry();
  }, [offline, online, retry]);
  // a transient answer is asked again by itself after a wait (parked while the window is hidden, asked at once when it shows): a link that stayed up through the machine's pause never turns offline-to-online, so nothing else would
  const transient =
    shown.state === 'retry' || (shown.state === 'offline' && machines.some((m) => m.status === 'online' && m.name === shown.machine));
  useEffect(() => {
    if (!transient || asking || auto >= RE_ASK_MS.length) return;
    const wait = RE_ASK_MS[auto];
    const since = Date.now();
    const stop = visiblePoll(
      `host-picture:${key}`,
      wait,
      () => {
        // a window that only took focus again, or showed again before the wait was over, has not waited yet
        if (Date.now() - since < wait - WAIT_SLACK_MS) return;
        stop();
        setMade({ key, n: auto + 1 });
        setAttempt((n) => n + 1);
      },
      { wake: true },
    );
    return stop;
  }, [transient, asking, auto, key]);
  useEffect(() => {
    const have = kept.get(key);
    if (have) return void setShown({ state: 'ready', url: have });
    let current = true;
    const quiet = lastTransient.current === key;
    setAsking(quiet);
    if (!quiet) setShown({ state: 'loading' });
    // a retry asks afresh rather than joining an answer still on its way
    void fetchPicture(attempt ? `${key}\n${attempt}` : key, chatId, src).then((reply) => {
      if (!current) return;
      setAsking(false);
      lastTransient.current = 'offline' in reply || 'retry' in reply ? key : null;
      if ('picture' in reply) {
        keep(key, reply.picture);
        setShown({ state: 'ready', url: reply.picture });
      } else if ('offline' in reply) setShown({ state: 'offline', machine: reply.offline });
      else if ('retry' in reply) setShown({ state: 'retry', machine: reply.retry });
      else if ('blocked' in reply) setShown({ state: 'blocked', machine: reply.blocked });
      else if ('update' in reply) setShown({ state: 'update', machine: reply.update });
      else setShown({ state: 'gone', machine: reply.machine });
    });
    return () => {
      current = false;
    };
  }, [chatId, src, key, attempt]);
  return { ...shown, retry, asking };
}

/** Forgets what was fetched (tests). */
export function resetHostPictures() {
  kept.clear();
  keptChars = 0;
  inflight.clear();
}
