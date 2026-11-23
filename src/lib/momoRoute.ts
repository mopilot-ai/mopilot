// Where main's 'momo' command opens MoMo's page (#2139): a MoMo notice's chat (electron/momo/notices.cjs), or the page itself (Ask MoMo's Open). MomoRoute still sends an account MoMo is off for home.
import type { Route } from '../../shared/model/window';

export function momoRouteOf(target: unknown): Route {
  const t = target && typeof target === 'object' ? (target as { kind?: unknown; chatId?: unknown }) : null;
  if (t?.kind === 'chat' && typeof t.chatId === 'string' && t.chatId) return { name: 'momo', tab: 'chat', chatId: t.chatId };
  return { name: 'momo' };
}

/** Whether MoMo's own rail is the page's one navigation column: its shell is on and its setup is done (before that the page is setup alone, with its nav column). */
export const momoRailOn = (route: { name: string }, momo: { shell: boolean; onboarding: { done: boolean } }) =>
  route.name === 'momo' && momo.shell && momo.onboarding.done;
