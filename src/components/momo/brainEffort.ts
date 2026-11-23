// The effort MoMo's brain chip offers (#2139): on Codex and Claude Code the brain's model's effort levels, kept with the
// brain (main checks and carries it, electron/momo/brainEffort.cjs); on a basic (ACP) harness, once MoMo's session is open,
// its own thought level, set on that session only (the harness's new-chat default stays). None (no More row) where the
// model has fewer than two levels.
import type { MomoBrain } from '../../lib/native';
import type { HarnessId } from '../../harness/types';
import { useHarnessModels } from '../../session/harness/select';
import { optionValues, setAcpConfig } from '../../session/harness/acp';
import { useBasicSelection } from '../../session/acpControls';

export interface BrainEffort {
  efforts: string[];
  /** the effort the next reply runs at */
  effort: string | null;
  /** a level's name, where the harness names its own */
  labelOf?: (effort: string) => string;
  /** the model's default effort; none: the harness keeps no default the chip knows */
  defaultEffort: string | null;
  pick: (effort: string) => void;
}

/**
 * The brain's effort control, or null where there is none. `setEffort` changes a first-tier brain's effort (main keeps it).
 * Both harness hooks run whatever the brain is, so the chip's hooks stay in order when the brain moves between them.
 */
export function useBrainEffort(
  brain: MomoBrain | null,
  h: HarnessId | null,
  chatId: string | null,
  setEffort: (brain: MomoBrain, effort: string) => void,
): BrainEffort | null {
  const models = useHarnessModels(h ?? 'claude');
  const basic = brain && !h ? brain.harness.slice('acp:'.length) : '';
  const sel = useBasicSelection(basic ? chatId : null, basic);
  if (!brain) return null;
  if (h) {
    const m = models.find((x) => (brain.model ? x.id === brain.model : x.isDefault));
    if (!m || m.efforts.length < 2) return null;
    const effort = brain.effort && m.efforts.includes(brain.effort) ? brain.effort : m.defaultEffort;
    return { efforts: m.efforts, effort, defaultEffort: m.defaultEffort, pick: (e) => setEffort(brain, e) };
  }
  const o = sel.live ? sel.options.find((x) => x.category === 'thought_level' && x.type === 'select') : undefined;
  const values = o ? optionValues(o) : [];
  if (!o || !chatId || values.length < 2) return null;
  const ids = values.map((v) => String(v.value));
  return {
    efforts: ids,
    effort: o.currentValue == null ? null : String(o.currentValue),
    // a current value the harness doesn't list goes by its id
    labelOf: (id) => values[ids.indexOf(id)]?.name ?? id,
    defaultEffort: null,
    // the panel picks only from `efforts`
    pick: (id) => void setAcpConfig(chatId, o.id, values[ids.indexOf(id)].value),
  };
}
