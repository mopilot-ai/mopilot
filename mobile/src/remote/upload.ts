// Sends a file or a recording to the Mac as an ordered chunk stream through chat.attach, with progress and cancel; a retry starts a new stream.
import { randomId } from '../platform/randomId';
import type { Owned } from './client';

/** A file the picker produced: its bytes as base64 and the type the Mac records; `uri` is a local image the composer can show as a thumbnail. */
export type Picked = { name: string; mime: string; base64: string; uri?: string };
export type Attached = { id: string; name: string };

import { MAX_AUDIO_BYTES, MAX_CHUNK, MAX_FILE_BYTES } from '../../../shared/remote/schema.mjs';

/** One chunk's base64 text and the Mac's limits for a file and a recording, as its schema has them. */
export const CHUNK = MAX_CHUNK;

export class Cancelled extends Error {
  constructor() {
    super('Upload cancelled.');
  }
}

/** Rejects with Cancelled as soon as the signal fires, so Cancel answers at once instead of after the chunk in flight. */
export const cancellable = <T>(work: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Cancelled());
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });

/** How many chunks base64 text needs. */
export const chunksFor = (base64: string) => Math.max(1, Math.ceil(base64.length / CHUNK));

/** Where a stream stands: kept by the caller, so a retry after a failure carries on from the part the Mac last confirmed. */
export type Resume = { stream: string | null; next: number };

/**
 * Sends the bytes in order and returns the Mac's last reply. Cancel stops before the next chunk and answers at once. With a
 * `resume` that has confirmed parts, the stream carries on from there; if the Mac no longer holds it (it forgets idle streams),
 * the file is sent again from the start under a new stream id.
 */
export async function sendChunks(
  request: Owned,
  file: Picked,
  purpose: 'file' | 'audio',
  onProgress: (sent: number, total: number) => void,
  signal: AbortSignal,
  resume: Resume = { stream: null, next: 0 },
): Promise<{ stream: string; reply: unknown }> {
  const limit = purpose === 'audio' ? MAX_AUDIO_BYTES : MAX_FILE_BYTES;
  if ((file.base64.length * 3) / 4 > limit)
    throw new Error(purpose === 'audio' ? 'That recording is too long.' : 'That file is larger than 20 MB.');
  const total = chunksFor(file.base64);
  const run = async () => {
    const stream = resume.stream ?? randomId();
    resume.stream = stream;
    onProgress(resume.next, total);
    let reply: unknown = null;
    for (let index = resume.next; index < total; index++) {
      if (signal.aborted) throw new Cancelled();
      const data = file.base64.slice(index * CHUNK, (index + 1) * CHUNK);
      reply = await cancellable(request('chat.attach', { stream, index, total, data, name: file.name, mime: file.mime, purpose }), signal);
      resume.next = index + 1;
      onProgress(resume.next, total);
    }
    return { stream, reply };
  };
  // only an attempt that carried on from earlier parts can have met a stream the Mac forgot
  const resumed = resume.next > 0;
  try {
    const sent = await run();
    if (signal.aborted) throw new Cancelled();
    return sent;
  } catch (e) {
    if (e instanceof Cancelled || !resumed) throw e;
    // the Mac may have forgotten the stream: start over once under a new id
    resume.stream = null;
    resume.next = 0;
    const sent = await run();
    if (signal.aborted) throw new Cancelled();
    return sent;
  }
}

/** Uploads a file and returns the attachment the Mac made. */
export async function upload(
  request: Owned,
  file: Picked,
  onProgress: (sent: number, total: number) => void,
  signal: AbortSignal,
  resume?: Resume,
): Promise<Attached> {
  const { reply } = await sendChunks(request, file, 'file', onProgress, signal, resume);
  const r = reply as { done?: unknown; id?: unknown } | null;
  if (!r || r.done !== true || typeof r.id !== 'string') throw new Error('Your computer did not confirm the file. Try again.');
  return { id: r.id, name: file.name };
}
