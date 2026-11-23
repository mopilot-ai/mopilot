// The five kinds of system notification; the main process (electron/platform/notify.cjs) decides
// whether each one is shown, per Settings → Notifications.
import type { ChatGoalStatus } from '../../shared/model/store';

export type NotifyKind = 'turn' | 'approval' | 'scheduled' | 'goal' | 'auth';

export interface NotifyOptions {
  title: string;
  body: string;
  /** The chat's name, listed in a merged notification ("3 chats need you"). */
  chatTitle?: string;
  /** The user is looking at this chat (the main process adds whether a window has focus). */
  viewing?: boolean;
  /** For kind 'goal': the status it reached. */
  status?: ChatGoalStatus;
}

export { goalNotice } from '../../shared/goalNotice.mjs';
