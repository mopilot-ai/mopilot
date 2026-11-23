// Whether a machine chat's failed turn asks for the machine's sign-in in its error box: the one condition the box (TurnView, chatActions.authRecovery) and the attention strip (HostAttentionStrip) read. Imports nothing heavy: the composer loads it.
import { useStore } from '../store/core';
import { hostOfChatNow } from '../lib/hostChats';
import { codeOfText } from '../../shared/host/turnErrorCode.mjs';

/** A failed turn's error on a machine chat is the machine's agent being signed out. @param message the turn's error */
export const machineSignInAsked = (chatId: string, message: string | null | undefined): boolean =>
  !!hostOfChatNow(chatId) && codeOfText(message) === 'auth';

/** Whether a turn draws its error box: it failed and is not running. */
export const drawsErrorBox = (turn: { error?: unknown; status?: string } | undefined, running: boolean): boolean =>
  !!turn?.error && !running;

/** Whether the chat's latest turn draws its error box with the machine's sign-in button: what the sign-in need is then already asked for. */
export function useAuthBoxShown(chatId: string): boolean {
  const turn = useStore((s) => s.runtime[chatId]?.turns?.at(-1));
  return drawsErrorBox(turn, turn?.status === 'inProgress') && machineSignInAsked(chatId, turn?.error?.message);
}
