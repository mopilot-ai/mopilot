// The Tasks pane's + (the design's "new task"): a task is asked for in MoMo's own composer, where it runs at once (design 5.3), so this puts the cursor there. Everything and MoMo's other pages have no composer, so Main opens first.
import { navigate } from '../../../store/panes';
import type { MomoTab } from '../MomoNav';

/** Where the focus goes once the page has drawn (the same beat as the app's own composer shortcuts). */
export const FOCUS_DELAY_MS = 50;

export function askForTask({ tab, feed }: { tab?: MomoTab; feed?: boolean }) {
  if (feed || (tab && tab !== 'chat')) navigate({ name: 'momo', tab: 'chat' });
  setTimeout(() => window.dispatchEvent(new Event('focus-composer')), FOCUS_DELAY_MS);
}
