// What a read of a chat's history leaves on the chat view: a failed read's error, with Retry, or turns read from disk
// while its harness is down, until a read of it succeeds.
import { errorText } from '../lib/ignored';
import type { ThreadRuntime } from './types';

/** A read of the chat failed: the chat view says why, with Retry, until a read of it succeeds. */
export const readFailed = (e: unknown): Partial<ThreadRuntime> => ({
  loading: false,
  loaded: true,
  error: errorText(e),
  errorFromRead: true,
});

/** What a later read replaces: a failed read's error, or turns read from disk while the harness was down. */
export const readStale = (r: ThreadRuntime) => !!(r.errorFromRead || r.fromDisk);

/**
 * A read of the chat succeeded: a failed read's error goes with it (another one, why a turn was refused, stays), and
 * the chat no longer shows what was read from disk.
 */
export const readSucceeded = (r: ThreadRuntime): Partial<ThreadRuntime> => ({
  ...(r.errorFromRead ? { error: null, errorFromRead: false } : {}),
  ...(r.fromDisk ? { fromDisk: false } : {}),
});
