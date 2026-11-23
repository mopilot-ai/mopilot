// Settings › MoMo › Brain › Background memory (#2139 P3, #2999 P2): what MoMo's background work may spend in a day and what it spent today, so its cost is visible: the one daily token cap (electron/momo/backgroundBudget.cjs) and each kind's share of it, the memory pass (electron/momo/memoryPass.cjs) and the search aliases of past chats and saved facts.
import { useCallback, useEffect, useState } from 'react';
import { native } from '../../../lib/native';
import type { MomoBackgroundShare, MomoMemoryLimits } from '../../../lib/native/contracts/momoMemory';
import { Group, Row } from '../../pages/settings/Controls';

const n = (v: number) => v.toLocaleString('en-US');
/** Today's estimated tokens under a cap, or that they can't be read now (never a 0 that isn't true). */
const use = ({ cap, today }: MomoBackgroundShare) =>
  today === null ? `Up to ${n(cap)} tokens a day; couldn't read today's use.` : `About ${n(today)} of ${n(cap)} tokens today.`;

export function BackgroundMemorySettings() {
  const [limits, setLimits] = useState<MomoMemoryLimits | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await native.momoMemory.background();
      setLimits(r.ok ? r.limits : null);
      setError(!r.ok);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
    // a pass that landed changed the memory: its use is read again
    return native.momoMemory.onChanged(() => void load());
  }, [load]);
  const status = error ? "Couldn't read its use." : 'Not running.';
  return (
    <Group title="Background memory" desc="MoMo saves facts and search aliases in the background, within one daily limit.">
      <Row title="Daily limit" desc={limits ? use(limits.daily) : status} />
      {limits && (
        <>
          <Row title="Memory" desc={`${use(limits.memory)} Up to ${n(limits.maxTokensPerPass)} tokens a pass.`} />
          <Row title="Search aliases" desc={use(limits.aliases)} />
        </>
      )}
    </Group>
  );
}
