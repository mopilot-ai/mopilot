// What the Memory tab's parts share (#2139, MemoryTab.tsx, MemoryChanges.tsx): a read of main redone on every change main broadcasts (the newest read wins), why a refused read means the tab is off, and how a fact's source and day are named.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { harnessInfo } from '../../harness/registry';
import type { MomoFact, MomoMemoryChange, MomoMemoryResult } from '../../lib/native/contracts/momoMemory';

export type Off = 'not_allowed' | 'unavailable' | null;
type Failed = Extract<MomoMemoryResult, { ok: false }>;
/** Why a refused call means the tab can't be used at all, else null. */
const offOf = (r: Failed): Off => (r.reason === 'not_allowed' || r.reason === 'unavailable' ? r.reason : null);
/** The harness a fact came from, by the name the user knows it ('Claude Code', or a basic harness's id). */
export const harnessName = (harness: string) => harnessInfo(harness as never)?.label ?? (harness.replace(/^acp:/, '') || 'Unknown');
/** Where a fact came from: you, or the harness of the MoMo chat that saved it. */
export const sourceName = (source: MomoFact['source']) => (source === 'user' ? 'You' : harnessName(source.harness));
/** Who made a change: you, MoMo's background pass, or the harness of the MoMo chat. */
export const byName = (by: MomoMemoryChange['by']) => (by === 'pass' ? 'MoMo' : sourceName(by));
/** The day a time falls on here, as YYYY-MM-DD (momoDay.ts). */
export { day } from './momoDay';

/** A read of main, done again by `load` and on every change main broadcasts; the newest read wins. */
export function useRead<T extends object>(read: () => Promise<MomoMemoryResult<T>>) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState<Off>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await read();
      if (mine !== seq.current) return;
      if (r.ok) {
        setValue(r);
        setError(null);
        setOff(null);
      } else {
        setOff(offOf(r));
        setError(r.error);
      }
    } catch (e) {
      if (mine === seq.current) setError(errorText(e));
    }
  }, [read]);
  useEffect(() => {
    void load();
    // MoMo saved or forgot a fact, or another window edited something
    const stop = native.momoMemory.onChanged(() => void load());
    return () => {
      // a read still on its way after the tab closed changes nothing
      seq.current++;
      stop();
    };
  }, [load]);
  return { value, error, off, load };
}
