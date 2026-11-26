// A picked video made ready to send: read as it is when it fits what the computer takes, else made smaller by the native module, else refused by name, and at once where the answer is certain (#5638).
import { File } from 'expo-file-system';
import { MAX_FILE_BYTES } from '../../../shared/remote/schema.mjs';
import { perf, type RungNote } from '../perfLog';
import type { Picked } from '../remote/upload';
import type { Compressed, VideoCompressor } from './videoCompress';

/** What the module is asked to stay under: a little below the cap, which its length limit only approximates. */
export const COMPRESS_LIMIT = Math.floor(MAX_FILE_BYTES * 0.97);
/** The fewest bits a second the smallest size makes of a video, picture and sound together. A longer video cannot fit however it is exported, so it is refused before any export. An estimate, set below what the sizes produce. */
export const MIN_BITRATE = 300_000;
export const TOO_LARGE = 'That video is larger than 20 MB. Trim it and try again.';
export const TOO_LONG = 'That video is too long to send. Trim it and try again.';
export const UNREADABLE = 'That video could not be read.';
export const NOT_PREPARED = 'That video could not be made smaller.';
export const BACKGROUND = 'The app has to stay open while a video gets smaller. Try again.';
export const DISK = 'There is not enough space on this phone to make that video smaller.';

/** The person cancelled while a video was being made smaller. */
export class Stopped extends Error {
  constructor() {
    super('Cancelled.');
  }
}

/** What the module's refusals say, by code. */
const MESSAGES: Record<string, string> = { ERR_VIDEO_TOO_LONG: TOO_LONG, ERR_VIDEO_BACKGROUND: BACKGROUND, ERR_VIDEO_DISK: DISK };

export type VideoAsset = {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number;
  duration?: number | null;
  width?: number;
  height?: number;
};
export type Hooks = {
  compressor: VideoCompressor | null;
  id: string;
  signal?: AbortSignal;
  progress?: (fraction: number, retry: boolean) => void;
};

/** Deletes a temporary file; one that is already gone is not a problem. */
export const removeCopy = (uri: string, compressor?: VideoCompressor | null) => {
  try {
    new File(uri).delete();
  } catch {
    // the file is gone already (or the system took it): there is nothing left to clean
  }
  compressor?.untrack(uri);
};
const mp4 = (name: string) => `${name.replace(/\.[^./]*$/, '') || 'video'}.mp4`;

/** Reads the file's bytes as base64 (after its size is known to fit). */
async function read(uri: string, name: string, mime: string): Promise<Picked> {
  try {
    return { name, mime, base64: await new File(uri).base64() };
  } catch {
    throw new Error(UNREADABLE);
  }
}

/** What the sentence a video was refused with says, as the log words it. */
const RESULTS: Record<string, string> = {
  [TOO_LARGE]: 'refused-large',
  [TOO_LONG]: 'refused-long',
  [BACKGROUND]: 'background',
  [DISK]: 'disk',
  [UNREADABLE]: 'unreadable',
};

/**
 * The video as a file to send. Throws an Error with the sentence to show, or `Stopped` after a cancel. While the performance log records, one line says what
 * happened to it (its length, size and dimensions, each size tried with its estimate, bytes and seconds, and how it ended): numbers and words, never a name or a path.
 */
export async function prepareVideo(asset: VideoAsset, hooks: Hooks): Promise<Picked> {
  const began = Date.now();
  const facts: Facts = { rungs: [], kept: null, bytes: null };
  let failure: unknown = null;
  let picked: Picked | null = null;
  try {
    picked = await ready(asset, hooks, facts);
  } catch (e) {
    failure = e;
  }
  const { rungs, kept } = facts;
  const result = !failure
    ? kept
      ? 'smaller'
      : 'fit'
    : failure instanceof Stopped
      ? 'cancelled'
      : (RESULTS[(failure as Error).message] ?? 'failed');
  perf.video({
    durationMs: asset.duration ?? null,
    sourceBytes: facts.bytes,
    width: asset.width ?? null,
    height: asset.height ?? null,
    rungs,
    kept,
    result,
    seconds: Math.round((Date.now() - began) / 100) / 10,
  });
  if (failure) throw failure;
  return picked as Picked;
}

/** What the log is told of one video as it is made ready: the sizes the module reported as they ended (extra detail, whatever order they arrive in), the size kept as the module's own answer says, and the source's bytes. */
type Facts = { rungs: RungNote[]; kept: string | null; bytes: number | null };

async function ready(asset: VideoAsset, hooks: Hooks, facts: Facts): Promise<Picked> {
  const name = asset.fileName ?? 'video.mp4';
  const mime = asset.mimeType ?? 'video/mp4';
  let size: number | null;
  try {
    // the picker usually says how large the copy is; when it does not, the file does
    size = asset.fileSize ?? new File(asset.uri).size;
  } catch {
    throw new Error(UNREADABLE);
  }
  facts.bytes = size;
  // a size neither knows is not read at all
  if (size === null) throw new Error(UNREADABLE);
  try {
    // it fits as it is: no export, no wait, and the original's quality
    if (size <= MAX_FILE_BYTES) return await read(asset.uri, name, mime);
    const { compressor, signal } = hooks;
    if (!compressor) throw new Error(TOO_LARGE);
    // certain before any export: a video this long cannot fit at any size
    if (asset.duration && (asset.duration / 1000) * (MIN_BITRATE / 8) > MAX_FILE_BYTES) throw new Error(TOO_LONG);
    if (signal?.aborted) throw new Stopped();
    const stop = () => compressor.cancel(hooks.id);
    // all three subscriptions are made, and ended, inside this try: one that fails to start leaves none of the others behind
    const ends: (() => void)[] = [];
    let smaller: Compressed;
    try {
      signal?.addEventListener('abort', stop, { once: true });
      ends.push(() => signal?.removeEventListener('abort', stop));
      ends.push(compressor.onProgress(hooks.id, (fraction, retry) => hooks.progress?.(fraction, retry)));
      ends.push(compressor.onRung(hooks.id, (rung) => facts.rungs.push(rung)));
      smaller = await compressor.compress(asset.uri, hooks.id, COMPRESS_LIMIT);
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code === 'ERR_VIDEO_CANCELLED') throw new Stopped();
      throw new Error(MESSAGES[code ?? ''] ?? NOT_PREPARED);
    } finally {
      for (const end of ends) end();
    }
    // which size was kept is the module's answer, not the order of its events: a size event that arrives after the answer is not waited for
    facts.kept = smaller.kept ?? facts.rungs.find((r) => r.outcome === 'kept')?.size ?? 'unknown';
    if (!facts.rungs.some((r) => r.outcome === 'kept'))
      facts.rungs.push({
        size: facts.kept,
        estimate: smaller.estimate ?? 0,
        bytes: smaller.size,
        seconds: smaller.seconds ?? 0,
        outcome: 'kept',
      });
    try {
      // the module keeps under the cap; a result that does not is not sent
      if (smaller.size > MAX_FILE_BYTES) throw new Error(TOO_LONG);
      return await read(smaller.uri, mp4(name), 'video/mp4');
    } finally {
      removeCopy(smaller.uri);
    }
  } finally {
    // the picker's copy is ours to clear once the video has been read or refused
    removeCopy(asset.uri, hooks.compressor);
  }
}
