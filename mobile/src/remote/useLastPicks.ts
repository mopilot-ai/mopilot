// New chat's memory of the last start on each computer (lastPicks.ts): the agent, model and effort offered first when the screen loads or the computer changes, never over a pick made on the screen.
import { useEffect, useRef, useState } from 'react';
import { lastPick, rememberPick, rememberedHarness, rememberedModel, type StartPick } from './lastPicks';

type Listed = readonly { id: string; unavailable?: boolean }[];
type Loaded = { models: Parameters<typeof rememberedModel>[2]; model: string | null; effort: string | null };
type Setters = {
  setHarness: (id: string) => void;
  setModel: (id: string | null) => void;
  setEffort: (id: string | null) => void;
};

/**
 * The computer a chat runs on is this Mac ('local') or the Host picked. Returns stable helpers for the screen's own loads
 * (the agent list, each agent's options) and the writes after a start; a computer picked while an agent's options are
 * already loaded applies its memory to them here.
 */
export function useLastPicks(
  pairId: string | null,
  where: { remote: boolean; host: string; harnesses: Listed; remember: (folder: string) => void },
  now: { start: unknown; harness: string; options: Loaded | null },
  set: Setters,
) {
  const target = where.remote ? where.host : 'local';
  const at = useRef({ pairId, target, where });
  at.current = { pairId, target, where };
  const [picks] = useState(() => {
    const last = () => lastPick(at.current.pairId, at.current.target);
    return {
      /** The remembered agent while it is listed ready, else null. */
      harness: (listed: Listed) => rememberedHarness(last(), listed),
      /** An agent's options loaded: its remembered model and effort while they are offered, else the ones the options chose. */
      apply: (harness: string, loaded: Loaded) => {
        const kept = rememberedModel(last(), harness, loaded.models, loaded);
        set.setModel(kept ? kept.model : loaded.model);
        set.setEffort(kept ? kept.effort : loaded.effort);
      },
      /** A chat started: its picks, and on a Host the folder it used (useMachinePick), are offered first next time. */
      remember: (pick: StartPick, folder: string | null) => {
        if (at.current.where.remote && folder) at.current.where.remember(folder);
        rememberPick(at.current.pairId, at.current.target, pick);
      },
    };
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: applied when the computer or the list changes, never over a pick made on the screen
  useEffect(() => {
    if (!now.start) return;
    const remembered = picks.harness(where.harnesses);
    if (!remembered) return;
    set.setHarness(remembered);
    // the same agent keeps its loaded options, so the computer's model and effort apply to them now (another agent's load applies them itself)
    if (
      remembered === now.harness &&
      now.options &&
      rememberedModel(lastPick(pairId, target), now.harness, now.options.models, now.options)
    )
      picks.apply(now.harness, now.options);
  }, [now.start, target]);
  return picks;
}
