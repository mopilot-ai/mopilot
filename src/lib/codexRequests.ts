// Codex app-server request builders for reverting a thread to a turn and starting an inline review.

import type { ReviewStartParams } from '../protocol/v2/ReviewStartParams';
import type { ReviewTarget } from '../protocol/v2/ReviewTarget';
import type { ThreadRevertParams } from '../protocol/v2/ThreadRevertParams';

/** Drop a turn and everything after it from a Codex thread's history (edit and resend). */
export function revertRequest(threadId: string, beforeTurnId: string): { method: 'thread/revert'; params: ThreadRevertParams } {
  return { method: 'thread/revert', params: { threadId, beforeTurnId } };
}

/** Start a review in the thread itself; detached delivery is deprecated in the app-server. */
export function reviewRequest(threadId: string, target: ReviewTarget): { method: 'review/start'; params: ReviewStartParams } {
  return { method: 'review/start', params: { threadId, target, delivery: 'inline' } };
}
