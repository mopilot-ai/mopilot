// The first moments of a launch, while the coding agents are still being looked for: what is happening, in words, and
// a cap on how long that is all the window shows (the welcome list follows, its rows still checking).
import { useAfter } from '../harness/installWatch';
import { Spinner } from '../ui/icons';

/** How long the window waits on detection alone before it shows the welcome list anyway. */
export const COLD_START_CAP_MS = 10_000;

/** True once a launch has spent COLD_START_CAP_MS looking for its agents. */
export const useColdStartCapped = (checking: boolean) => useAfter(COLD_START_CAP_MS, checking);

export function ColdStart() {
  return (
    <div className="center-fill welcome-cold" role="status">
      <Spinner size={18} />
      <span className="login-hint">Looking for your coding agents…</span>
    </div>
  );
}
