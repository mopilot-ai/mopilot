// Stop as the composer shows it (#4626): Stopping… from the tap, until the turn is seen to end; a Stop the Mac refused can be tapped again.
import { useEffect, useState } from 'react';

/** @param running a turn is running @param stop sends the stop; resolves false when it was refused */
export function useStopping(running: boolean, stop: () => Promise<boolean>) {
  const [requested, setRequested] = useState(false);
  // a turn that ended (or a new one) is no longer being stopped
  useEffect(() => {
    if (!running) setRequested(false);
  }, [running]);
  return {
    stopping: requested && running,
    stop: () => {
      setRequested(true);
      void stop().then((ok) => !ok && setRequested(false));
    },
  };
}
