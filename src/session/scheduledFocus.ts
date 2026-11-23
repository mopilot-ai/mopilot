// Opening the Scheduled page on one task from elsewhere (a chat's scheduled-task card), without loading that page's code.
import { navigate } from '../store/panes';

/** The window event the Scheduled page listens for while it is open. */
export const SHOW_TASK_EVENT = 'show-scheduled-task';

let pending: string | null = null;

/** Go to the Scheduled page with this task selected. */
export function showScheduledTask(id: string) {
  pending = id;
  navigate({ name: 'scheduled' });
  window.dispatchEvent(new CustomEvent(SHOW_TASK_EVENT, { detail: id }));
}

/** The task asked for before the Scheduled page opened, once. */
export function takeScheduledFocus(): string | null {
  const id = pending;
  pending = null;
  return id;
}
