// Who sees MoMo's phone screens: only an invited account whose computer says it serves MoMo's home; nobody else sees any of it.
import { homeOffered } from '../../../shared/momoHomeHello.mjs';
import { momoAllowed } from '../momo/contract';

/** Whether the hello lets this account use MoMo's home screens: MoMo allowed (the invite gate) and the home offered, read by the one rule the home lane owns (shared/momoHomeHello.mjs); anything else is no. */
export function momoHomeAllowed(hello: unknown): boolean {
  return momoAllowed(hello) && homeOffered(hello as Parameters<typeof homeOffered>[0]);
}

/** The Mac's method that turns a MoMo voice note into text (the classic MoMo chat's own). */
export const MOMO_VOICE_METHOD = 'momo.chat.transcribe';

/** Whether the computer lists the voice method, so the composer offers a microphone. */
export function listsVoice(hello: unknown): boolean {
  const methods = (hello as { capabilities?: { methods?: unknown } } | null)?.capabilities?.methods;
  return Array.isArray(methods) && methods.includes(MOMO_VOICE_METHOD);
}
