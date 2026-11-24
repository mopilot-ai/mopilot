// What a chat's messages and errors offer, per harness. Components ask here instead of asking which
// harness a chat is on (tests/boundary.test.ts).
import { ratingEvent } from './ratings';
import { sendRating } from '../lib/telemetry';
import { errorText } from '../lib/ignored';
import { chatFamily, openMachines, usageHarnessOf } from '../store/chats';
import { onMachineNow } from '../lib/hostChats';
import { machineSignInAsked } from './machineAuthBox';
import { get as getState, toast } from '../store/core';
import { sendFeedback } from '../store/connection';
import { HARNESS_TRAITS, type HarnessFamily } from '../harness/family';
import { signInAccountFor } from '../harness/accounts';
import { recheckClaude, reloginClaudeAccount } from './harness/claude';
import { basicAuthRecovery } from './harness/acp';
import { openBugReport } from '../lib/bugReportEvent';
import { isClaudeAuthError } from '../harness/types';
import type { AppState } from '../store/state';

/** The buttons a signed-out error offers: Sign in (its label says how) and Re-check. */
export interface AuthRecovery {
  label: string;
  signIn(): void;
  /** absent where there is nothing of this Mac's to check again (a chat on a machine) */
  recheck?(): void;
  /** a sign-in that waits on a login elsewhere: shown with Cancel in place of the buttons while it waits */
  waiting?: {
    /** what it waits for, read from the store; null when no sign-in waits */
    text(s: AppState): string | null;
    cancel(): void;
  };
}

/** Claude Code: the login this chat runs on, not the one new chats use (D-43). */
function claudeAuthRecovery(chatId: string, message: string | null | undefined): AuthRecovery | null {
  if (!isClaudeAuthError(message)) return null;
  const signIn = () => {
    const s = getState();
    void reloginClaudeAccount(signInAccountFor(s.claudeChats, s.claudeAccounts, chatId));
  };
  const recheck = () => {
    const s = getState();
    void recheckClaude(signInAccountFor(s.claudeChats, s.claudeAccounts, chatId));
  };
  return { label: 'Sign in', signIn, recheck };
}

/** Each family's recovery for a failed turn's error. */
const AUTH_RECOVERY: Record<HarnessFamily, (chatId: string, message: string | null | undefined) => AuthRecovery | null> = {
  claude: claudeAuthRecovery,
  // a lapsed Codex sign-in is the re-verify banner's (AccountExpiredBanner), not a failed turn's
  codex: () => null,
  acp: basicAuthRecovery,
};

/** A signed-out error on a chat: the buttons to recover, or null when the error is something else. */
export function authRecovery(chatId: string, message: string | null | undefined): AuthRecovery | null {
  // a chat on a machine failed on that machine's sign-in: this Mac's logins are not what to fix, so the way on is the machine's row.
  // While it is not known where the chat runs nothing is offered: a sign-in started on this Mac for a chat that is not here would be the wrong one
  if (onMachineNow(chatId)) return machineSignInAsked(chatId, message) ? { label: 'Sign in on machine', signIn: openMachines } : null;
  return AUTH_RECOVERY[chatFamily(chatId)](chatId, message);
}

/** The bug report about this chat, opened on "Bad result": a bad reply's own entry to it, on every harness. */
export const reportBadReply = (chatId: string) => openBugReport(chatId, 'bad_result');

/**
 * A thumbs up or down on a reply: Codex uploads it as feedback, the other harnesses count it as usage data, the click
 * being consent to send it even with sharing off. Thanks the user, or says why it went nowhere (a failed upload); resolves
 * to whether it went through. A thumbs down also offers to report a bug about the chat.
 */
export async function rateReply(chatId: string, kind: 'good' | 'bad'): Promise<boolean> {
  const family = chatFamily(chatId);
  try {
    if (HARNESS_TRAITS[family].rating === 'upload') await sendFeedback(chatId, kind === 'good' ? 'good_result' : 'bad_result', null, false);
  } catch (e) {
    toast(`Couldn't send the feedback: ${errorText(e)}`, 'error');
    return false;
  }
  const rating = ratingEvent(family, usageHarnessOf(chatId), kind);
  if (rating) sendRating(rating);
  if (kind === 'bad') toast('Thanks for the feedback', 'info', { action: { label: 'Report a bug…', run: () => reportBadReply(chatId) } });
  else toast('Thanks for the feedback');
  return true;
}
