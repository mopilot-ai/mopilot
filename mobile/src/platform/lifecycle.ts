// Observe the phone returning to the foreground, and for how long it was away, so a disconnected relay can be retried and a socket the OS left half open is replaced.
import { AppState } from 'react-native';
import { startCatchUp } from '../catchUp';

/** Whether the app is in front now. */
export const isActive = () => AppState.currentState === 'active';

export function onForeground(listener: (awayMs: number) => void) {
  let leftAt: number | null = null;
  const subscription = AppState.addEventListener('change', (state) => {
    if (state !== 'active') {
      leftAt ??= Date.now();
      return;
    }
    const away = leftAt === null ? 0 : Date.now() - leftAt;
    leftAt = null;
    // back in front: the backlog of what happened meanwhile is taken in without pacing (see catchUp.ts)
    startCatchUp();
    listener(away);
  });
  return () => subscription.remove();
}
