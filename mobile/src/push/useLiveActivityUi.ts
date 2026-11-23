// React binding for the Live Activity controller: the switch, its status and whether the last attempt failed. Read-only; the app starts the controller.
import { useEffect, useState } from 'react';
import type { LiveActivityController, LiveActivityUi } from './liveActivityController';

export function useLiveActivityUi(activity: LiveActivityController): LiveActivityUi {
  const [ui, setUi] = useState<LiveActivityUi>(activity.ui());
  useEffect(() => {
    setUi(activity.ui());
    return activity.subscribe(() => setUi(activity.ui()));
  }, [activity]);
  return ui;
}
