// A nudge in MoMo's chat (#2139 P4): a note main wrote (electron/app/momoNudges.cjs), shown as MoMo's line, never as the user's, with why (the loop, the user's own words and the day they said them, what fired) one click away, and Done, Snooze, Dismiss for its loop. What was done shows in place of the buttons.
import { useState } from 'react';
import { BellRing } from 'lucide-react';
import type { NudgeNote } from '../../../shared/model/store';
import { LoopActions, loopState, saidLine } from './loopActions';

export function NudgeCard({ text, nudge }: { text: string; nudge: NudgeNote }) {
  const [why, setWhy] = useState(false);
  const [state, setState] = useState<string | null>(null);
  return (
    <div className="step-row status-note nudge momo-nudge" data-loop={nudge.loopId}>
      <span className="step-icon">
        <BellRing size={16} strokeWidth={1.6} />
      </span>
      <span className="step-text">
        {text}{' '}
        <button className="btn-link" aria-expanded={why} onClick={() => setWhy((v) => !v)}>
          Why
        </button>
        {why && (
          <span className="momo-nudge-why">
            <span>{nudge.title}</span>
            <span>{saidLine(nudge.quote, nudge.saidAt)}</span>
            <span>{nudge.why}</span>
          </span>
        )}
        <span className="momo-nudge-actions">
          {state ? (
            <span className="applies-to momo-chip expired">{state}</span>
          ) : (
            <LoopActions id={nudge.loopId} open title={nudge.title} done={(l) => setState(loopState(l, Date.now()) ?? 'Reopened')} />
          )}
        </span>
      </span>
    </div>
  );
}
