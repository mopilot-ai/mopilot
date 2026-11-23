// Where scheduled tasks run right now, for the Scheduled page and Settings: whether the scheduler is on, and whether the Codex app and Claude Desktop are installed and open.
import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import type { AppsState } from '../../lib/scheduleTask';
import { createLatestLoader } from '../../lib/latestLoader';

/**
 * Main's answer (automation:apps): asked on mount, when a task changes, and when the window comes back to the
 * front (the user opened or quit the other app away from this window; nothing tells main). Null until the first answer.
 */
export function useAutomationApps(): AppsState | null {
  const [apps, setApps] = useState<AppsState | null>(null);
  useEffect(() => {
    // A failed read keeps the last status; the next change or focus asks again.
    const loader = createLatestLoader(() => native.automation.apps(), setApps);
    const ask = () => void loader.load();
    ask();
    const off = native.automation.onChanged(ask);
    window.addEventListener('focus', ask);
    return () => {
      loader.stop();
      off();
      window.removeEventListener('focus', ask);
    };
  }, []);
  return apps;
}
