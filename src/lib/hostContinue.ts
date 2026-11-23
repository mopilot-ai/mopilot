// The window's calls for switching a chat's host: the answers come as {value} or {error: {message, code}} (a thrown Error loses its `code` crossing the bridge), so each is unwrapped into a value or an Error that carries the refusal's code (refusalCopy reads it).
import { native } from './native';
import { unwrap } from './hostFolders';

type ContinueReq = Parameters<typeof native.host.continueChat>[0];
type PlanReq = Parameters<typeof native.host.codePlan>[0];

export const hostContinue = {
  /** Continues the chat on another machine; rejects with the refusal's `code`. */
  run: (req: ContinueReq) => unwrap(native.host.continueChat(req)),
  /** What carrying the chat's uncommitted changes to the folder would send, or null. */
  plan: (req: PlanReq) => unwrap(native.host.codePlan(req)),
  /** The dialog ended without a continue: what it held for the move goes to the chat's owner. */
  release: (chatId: string) => unwrap(native.host.planRelease(chatId)),
};
