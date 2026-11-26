// The native video module (a Swift export session, iOS only): makes a picked video smaller, with progress and cancel; null on a build whose native shell has no such module, and on Android.
/** The smaller copy: where it is, its bytes, and which size was kept, with that size's estimate and seconds (the answer itself, whatever order the size events arrive in). */
export type Compressed = { uri: string; size: number; kept?: string; estimate?: number; seconds?: number };
/** What happened at one size the module tried (numbers and words only): the size's name, the system's estimate and what was written in bytes, seconds, and how it ended. */
export type Rung = { size: string; estimate: number; bytes: number; seconds: number; outcome: string };
export type VideoCompressor = {
  /** A smaller copy of the file at `uri`, at most `limit` bytes; rejects with `code` 'ERR_VIDEO_TOO_LONG' when even the smallest size cannot hold all of it, 'ERR_VIDEO_CANCELLED' after `cancel(id)`. */
  compress(uri: string, id: string, limit: number): Promise<Compressed>;
  cancel(id: string): void;
  /** Progress of the export named `id` (0 to 1, of the size being made; `retry` once a smaller size is tried after another gave up); returns what stops listening. */
  onProgress(id: string, listener: (fraction: number, retry: boolean) => void): () => void;
  /** Each size the module tried for the export named `id`, as it ends; returns what stops listening. */
  onRung(id: string, listener: (rung: Rung) => void): () => void;
  /** The picker's copies of the videos picked: removed at the next launch if the app was killed before they were. */
  track(uris: string[]): void;
  /** A copy that was read or removed. */
  untrack(uri: string): void;
};

type Native = {
  compress(uri: string, id: string, limit: number): Promise<Compressed>;
  cancel(id: string): void;
  /** Absent on a native build older than this JS: the phone then tracks nothing. */
  track?(uris: string[]): void;
  untrack?(uri: string): void;
  addListener(event: 'onProgress', listener: (e: { id: string; progress: number; retry?: boolean }) => void): { remove(): void };
  addListener(event: 'onRung', listener: (e: Rung & { id: string }) => void): { remove(): void };
};

/** Where the native module is looked up; a test puts its own here. */
export const nativeVideo: { load: () => Native | null } = { load: () => require('expo').requireOptionalNativeModule('MoPilotVideo') };

/** Read through the optional lookup: requiring a module this shell does not have must not throw while the app loads. */
export function videoCompressor(): VideoCompressor | null {
  let native: Native | null = null;
  try {
    native = nativeVideo.load();
  } catch {
    // a shell that cannot say has none
    native = null;
  }
  if (!native) return null;
  const module = native;
  return {
    compress: (uri, id, limit) => module.compress(uri, id, limit),
    cancel: (id) => module.cancel(id),
    onRung: (id, listener) => {
      const subscription = module.addListener('onRung', ({ id: from, ...rung }) => {
        if (from === id) listener(rung);
      });
      return () => subscription.remove();
    },
    track: (uris) => module.track?.(uris),
    untrack: (uri) => module.untrack?.(uri),
    onProgress: (id, listener) => {
      const subscription = module.addListener('onProgress', (event) => {
        if (event.id === id) listener(event.progress, event.retry === true);
      });
      return () => subscription.remove();
    },
  };
}
