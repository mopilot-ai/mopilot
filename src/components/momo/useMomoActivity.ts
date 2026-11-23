// MoMo's recent activity for its right panel (#2139): the routine runs and errands main lists (momo.activity.list, what a phone's Activity shows), read while the panel is mounted and again whenever main says an item changed; the newest read wins, and a failed read says so instead of showing an empty list.
import { useEffect, useState } from 'react';
import { native, type MomoActivityItem } from '../../lib/native';
import { errorText, ignoring } from '../../lib/ignored';

export type MomoActivityState =
  | { status: 'loading' }
  | { status: 'ready'; items: MomoActivityItem[] }
  | { status: 'error'; message: string };

export function useMomoActivity(): MomoActivityState {
  const [state, setState] = useState<MomoActivityState>({ status: 'loading' });
  useEffect(() => {
    let latest = 0;
    const read = () => {
      const seq = ++latest;
      native.momoChat.activityList().then(
        (r) => seq === latest && setState({ status: 'ready', items: r.items }),
        (e: unknown) => seq === latest && setState({ status: 'error', message: errorText(e) }),
      );
    };
    const off = native.momoChat.onActivityChanged(read);
    // main tells a window of changes only once it says it shows the activity
    native.momoChat.watchActivity(true).then(read, read);
    return () => {
      latest = -1;
      off();
      native.momoChat.watchActivity(false).catch(ignoring('stop watching MoMo’s activity'));
    };
  }, []);
  return state;
}
