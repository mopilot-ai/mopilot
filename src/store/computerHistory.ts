// Computer History in the windows (#1363): its state as main reports it (read once, then followed through computerHistory:changed), the words for each status, and a change that toasts its failure or refusal and answers whether it went through.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../lib/native';
import { errorText } from '../lib/ignored';
import { toast } from './core';
import type { ComputerHistoryResult, ComputerHistoryState, ComputerHistoryStatus } from '../lib/native/computerHistory';

export type ComputerHistoryExclusions = { apps: { pattern: string; reason: string }[]; healthSites: string[] };

/** What each status says, in Settings and in the sidebar. */
export const STATUS_LABEL: Record<ComputerHistoryStatus, string> = {
  off: 'Off',
  recording: 'Recording',
  paused: 'Paused',
  suspended: 'Stopped while the Mac is locked or asleep',
  'needs-permission': 'Needs Accessibility',
  unavailable: 'Waiting for the computer-use helper',
  'store-unavailable': "Can't save right now",
};

/** The same, short enough for the sidebar row. */
export const SHORT_LABEL: Record<ComputerHistoryStatus, string> = {
  off: 'Off',
  recording: 'Recording',
  paused: 'Paused',
  suspended: 'Stopped',
  'needs-permission': 'Needs Accessibility',
  unavailable: 'Waiting',
  'store-unavailable': "Can't save",
};

/** What the status row says under the status: the failure's sentence only while that failure is the status. */
export function statusDetail(state: ComputerHistoryState): string | undefined {
  switch (state.status) {
    case 'recording':
      return 'Recording the apps and sites below.';
    case 'paused':
      return 'Nothing is recorded until you resume.';
    case 'suspended':
      return state.suspended.includes('quit') ? 'Stopped while MoPilot quits.' : 'It goes on by itself when the Mac is unlocked or awake.';
    case 'needs-permission':
    case 'unavailable':
    case 'store-unavailable':
      return state.error ?? undefined;
    default:
      return undefined;
  }
}

/** Why a call answered no, as a sentence. */
export function refusalOf(r: ComputerHistoryResult<object>): string | null {
  if (r.ok) return null;
  return r.reason ?? r.error ?? 'It did not go through';
}

/**
 * The state, read when mounted and kept current by main's broadcasts; a newer read wins over an older one, so a slow
 * first read can't put back a state a broadcast already replaced.
 */
export function useComputerHistory() {
  const [state, setState] = useState<ComputerHistoryState | null>(null);
  const [exclusions, setExclusions] = useState<ComputerHistoryExclusions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await native.computerHistory.state();
      // the exclusions never change in a run: kept even from a read a broadcast overtook
      if (r.ok) setExclusions(r.exclusions);
      if (mine !== seq.current) return;
      if (!r.ok) return setError(refusalOf(r));
      setState(r.state);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const off = native.computerHistory.onChanged((s) => {
      // a broadcast is newer than any read still on its way
      seq.current++;
      setState(s);
      setError(null);
    });
    return off;
  }, [load]);

  /** Runs a change; a refusal or failure is toasted. True when it went through. */
  const change = useCallback(async (what: string, run: () => Promise<ComputerHistoryResult<object>>) => {
    try {
      const r = await run();
      if (r.ok) {
        seq.current++;
        setState(r.state);
        return true;
      }
      toast(`Couldn't ${what}: ${refusalOf(r)}`, 'error');
    } catch (e) {
      toast(`Couldn't ${what}: ${errorText(e)}`, 'error');
    }
    return false;
  }, []);

  return { state, exclusions, error, load, change };
}

/** Just the status, for the sidebar: null until read, and while Computer History is off. */
export function useComputerHistoryStatus(): ComputerHistoryStatus | null {
  const [status, setStatus] = useState<ComputerHistoryStatus | null>(null);
  useEffect(() => {
    let live = true;
    let heard = false;
    native.computerHistory.state().then(
      (r) => live && !heard && r.ok && setStatus(r.state.status),
      // no status: the sidebar shows nothing, Settings says why
      () => undefined,
    );
    const off = native.computerHistory.onChanged((s) => {
      heard = true;
      setStatus(s.status);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return status === 'off' ? null : status;
}

/** "Today", "Yesterday" or the day's date, for a day key. */
export function dayLabel(day: string, now = new Date()): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today.getTime() - date.getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** Record a skill: the new chat's box is the draft key 'home'. */
export const HOME_KEY = 'home';
/** What the composer starts with after a recording. */
export const RECORDING_PROMPT = 'Turn this recording into a skill.';

/** The attachment for a recording's block (a Computer History attachment, which every harness takes the same way): short, so the composer's chip shows it whole. */
export function recordingAttachment(steps: number, block: string) {
  return {
    kind: 'computerHistory' as const,
    path: 'computer-history:recording',
    name: `Recording · ${steps} ${steps === 1 ? 'step' : 'steps'}`,
    text: block,
  };
}
