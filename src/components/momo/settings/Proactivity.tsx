// Settings › MoMo › Brain › Proactivity (#2139): how much MoMo does on its own (Off / Low / Default / High, described from the limits MoMo's routines enforce, MOMO_PROACTIVITY_LIMITS), quiet hours (no routine runs) whether MoMo notifies when it needs an answer, and whether a phone alert names the routine that raised it (A6). Each change is saved through main (src/session/momoPrefs.ts).
import { useEffect, useState } from 'react';
import { MOMO_DEFAULTS, MOMO_PROACTIVITY, MOMO_PROACTIVITY_LIMITS, type MomoProactivity } from '../../../../shared/momoPrefs.mjs';
import { saveMomoPref, useMomoPrefs } from '../../../session/momoPrefs';
import { Group, Row, Segmented, Toggle } from '../../pages/settings/Controls';
import { toast } from '../../../store/core';
import { isEnter } from '../../../lib/focus';
import { useEarlierBriefing } from '../../../lib/momoEarlierBriefing';

const LABEL: Record<MomoProactivity, string> = { off: 'Off', low: 'Low', default: 'Default', high: 'High' };
/** Each level as its limits make it. */
const LEVELS = MOMO_PROACTIVITY.map((value) => {
  const { runs } = MOMO_PROACTIVITY_LIMITS[value];
  return { value, label: LABEL[value], desc: runs ? `Up to ${runs} routine runs a day.` : 'No routines.' };
});

/**
 * A time of day ('HH:MM'), saved when the field is left (or Enter): typing "12" passes through 01:… on the way. A time
 * that wasn't saved (refused here, or by main) goes back to the saved one, so the field never shows what isn't saved.
 */
export function TimeInput({
  value,
  label,
  onCommit,
}: {
  value: string;
  label: string;
  onCommit: (v: string) => boolean | Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  // a change saved elsewhere (another window) shows here
  useEffect(() => setDraft(value), [value]);
  const commit = async () => {
    if (draft === value) return;
    if (!/^\d\d:\d\d$/.test(draft) || !(await onCommit(draft))) setDraft(value);
  };
  return (
    <input
      type="time"
      className="text-input slim momo-time"
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => isEnter(e) && e.currentTarget.blur()}
    />
  );
}

export function ProactivitySettings() {
  const p = useMomoPrefs();
  const r = p.routines;
  const q = r.quietHours;
  const level = LEVELS.find((l) => l.value === r.proactivity)!;
  const earlier = useEarlierBriefing(p.brief);
  // start and end can't be the same time: that change is not saved
  const quiet = (part: 'start' | 'end', v: string) => {
    const next = { ...q!, [part]: v };
    if (next.start !== next.end) return saveMomoPref('routines.quietHours', next);
    toast("Quiet hours can't start and end at the same time", 'error');
    return false;
  };
  return (
    <Group title="Proactivity">
      <Row title="How often MoMo reaches out" desc={level.desc}>
        <Segmented<MomoProactivity>
          label="Proactivity"
          value={r.proactivity}
          options={LEVELS}
          onChange={(v) => void saveMomoPref('routines.proactivity', v)}
        />
      </Row>
      <Row title="Quiet hours" desc={q ? 'No routines run between these times.' : 'Off'}>
        {q && (
          <>
            <TimeInput label="Quiet hours start" value={q.start} onCommit={(v) => quiet('start', v)} />
            <span className="momo-time-sep">–</span>
            <TimeInput label="Quiet hours end" value={q.end} onCommit={(v) => quiet('end', v)} />
          </>
        )}
        {/* turned on again, they start at the usual times */}
        <Toggle on={!!q} onChange={(on) => saveMomoPref('routines.quietHours', on ? { ...MOMO_DEFAULTS.routines.quietHours! } : null)} />
      </Row>
      {/* a Mac-only setting (A7): off until turned on here or on setup's second screen */}
      <Row
        title="Morning brief"
        desc={
          earlier
            ? (earlier.error ?? 'Your earlier Morning briefing routine is still on.')
            : 'A short note in MoMo’s chat when quiet hours end, if there is something to say.'
        }
      >
        {earlier && (
          <button type="button" className="btn sm" disabled={earlier.busy} onClick={() => void earlier.turnOff()}>
            Turn it off
          </button>
        )}
        <Toggle on={p.brief} onChange={(v) => saveMomoPref('brief', v)} />
      </Row>
      <Row title="Notify when MoMo needs an answer">
        <Toggle on={p.notify.needsAnswer} onChange={(v) => saveMomoPref('notify.needsAnswer', v)} />
      </Row>
      {/* a Mac-only setting (A6): a phone is shown the result and cannot change it */}
      <Row
        title="Name my routine in phone alerts"
        desc="Only the name of a routine you approved, and only if Chat titles is on in your phone’s alerts. Off: “MoMo needs you”."
      >
        <Toggle on={p.notify.pushBody} onChange={(v) => saveMomoPref('notify.pushBody', v)} />
      </Row>
    </Group>
  );
}
