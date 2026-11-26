// Sends a file or a recording to the Mac as an ordered chunk stream through chat.attach, with progress and cancel; a retry starts a new stream.
import { randomId } from '../platform/randomId';
import type { Owned } from './client';
import { lostInFlight } from './unconfirmed';

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

/** The error, or one it was worded from, says `pattern`. */
const says = (error: unknown, pattern: RegExp, depth = 0): boolean =>
  error instanceof Error && (pattern.test(error.message) || (depth < 4 && says(error.cause, pattern, depth + 1)));

/**
 * A chunk the connection lost, not the Mac refused: it went as the connection dropped, or it was made on a connection that has since been replaced.
 * Sent again on the connection that comes back, from the part the Mac confirmed.
 */
export const connectionLost = (error: unknown): boolean =>
  // `session closed`: the phone's channel closed under the request (never a refusal of the part)
  lostInFlight(error) || says(error, /^(The connected computer changed|session closed$)/);

/** The phone saw the computer away when the chunk was to go (asleep, or not yet back after a reconnect). */
export const computerAway = (error: unknown): boolean => says(error, /^Computer is offline/);

/** The screen's request now names another computer: the rest of the file is not sent there. */
export class OtherComputer extends Error {
  constructor() {
    super('The connected computer changed. Try again.');
  }
}

/**
 * How a part's request ended, in fixed words for the performance log: `other-computer`, `cancelled`, `session-closed` (the phone's channel closed under
 * it), `timeout`, `lost` (the connection dropped under it), `stale` (made on a connection since replaced), `away` (the computer was away),
 * `no-connection`, `relay-refused` with the relay's code (one of its fixed words), `unreadable` (a reply the phone could not read), or `refused` (the Mac
 * or the phone said no) with the error's code when it carries one. Never the error's words.
 */
export function partOutcome(error: unknown): { outcome: string; code?: string } {
  if (error instanceof OtherComputer) return { outcome: 'other-computer' };
  if (error instanceof Cancelled) return { outcome: 'cancelled' };
  if (says(error, /^session closed$/)) return { outcome: 'session-closed' };
  if (says(error, /timed out/i)) return { outcome: 'timeout' };
  if (lostInFlight(error)) return { outcome: 'lost' };
  if (says(error, /^The connected computer changed/)) return { outcome: 'stale' };
  if (computerAway(error)) return { outcome: 'away' };
  if (says(error, /^Connect to a computer first/)) return { outcome: 'no-connection' };
  const relay = relayCode(error);
  if (relay) return { outcome: 'relay-refused', code: relay };
  const code = codeOf(error);
  if (code === 'reply_unreadable') return { outcome: 'unreadable' };
  return code ? { outcome: 'refused', code } : { outcome: 'refused' };
}

/** The relay's own word for a frame it refused (`relay: forbidden`): phoneRelay names only words of its fixed list, or `error`. */
function relayCode(error: unknown, depth = 0): string | undefined {
  if (!(error instanceof Error) || depth > 4) return undefined;
  const word = /^relay: ([a-z_]+)$/.exec(error.message)?.[1];
  return word ?? relayCode(error.cause, depth + 1);
}

/** A code of letters, digits and underscores the error (or one it was worded from) carries: the Mac's codes are lower case, the phone's upper. */
function codeOf(error: unknown, depth = 0): string | undefined {
  if (!(error instanceof Error) || depth > 4) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{2,40}$/.test(code) ? code : codeOf(error.cause, depth + 1);
}

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
    // a lost connection says nothing of the stream: the caller tries again from the part the Mac confirmed
    if (e instanceof Cancelled || !resumed || connectionLost(e)) throw e;
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
