// MoMo's setup (#2139, redone as a first run in #2607): shown on the MoMo page until it is finished (prefs.momo.onboarding), three screens and no way to skip: Meet (name and color; the brain is chosen for the user), Notifications (optional, with the Morning brief, A7; Calendar and Reminders are asked for in MoMo's chat when it needs them) and Setting up (runSetup.ts's real work, drawn only if it takes a moment). When it is done the page is MoMo's Chat, where MoMo speaks first. More about MoMo lives in Settings › MoMo.
import { useEffect, useRef, useState } from 'react';
import { errorText } from '../../../lib/ignored';
import { useMomoPrefs } from '../../../session/momoPrefs';
import { useSetupBrain } from './BrainRow';
import { MeetStep } from './MeetStep';
import { NotificationsStep } from './NotificationsStep';
import { ProgressStep, SHOW_AFTER_MS } from './ProgressStep';
import { runSetup } from './runSetup';

type Step = 'meet' | 'notifications' | 'running';

export function MomoSetup() {
  const { probes, shown, allLimited, ready } = useSetupBrain();
  // MoMo says hello the first time only, not when setup is run again from Settings (read once: a run that is tried again still greets)
  const prefs = useMomoPrefs();
  const [first] = useState(() => prefs.routines.starter.length === 0);
  const [step, setStep] = useState<Step>('meet');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  /** one run at a time: a second click waits for the first */
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setStep('running');
    setError(null);
    setProgress(0);
    setShowProgress(false);
    timer.current = setTimeout(() => setShowProgress(true), SHOW_AFTER_MS);
    try {
      await runSetup({ brain: shown, first, onStep: setProgress });
      // done: the page is now MoMo's Chat, and this screen is gone
    } catch (e) {
      setError(errorText(e));
      setRetry(() => () => void run());
    } finally {
      clearTimeout(timer.current);
      running.current = false;
    }
  };

  // Notifications stays on screen (its buttons off) while the work is short, so nothing flashes past
  const notifying = step === 'notifications' || (step === 'running' && !showProgress && !error);
  return (
    <div className="momo-setup">
      {probes}
      {step === 'meet' && <MeetStep brain={shown} ready={ready} allLimited={allLimited} onDone={() => setStep('notifications')} />}
      {notifying && <NotificationsStep busy={step === 'running'} onDone={() => void run()} />}
      {step === 'running' && !notifying && <ProgressStep step={progress} error={error} onRetry={() => retry?.()} />}
    </div>
  );
}
