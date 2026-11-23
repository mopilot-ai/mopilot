// Whether each supported harness is installed here, for the install lists: first-class ones from their detected
// status, basic ones from their admission list. One shape for both, so the lists never ask which harness it is.
import type { AppState } from '../../store/state';
import { harnessStatus } from './select';
import { harnessInfo } from '../../harness/registry';
import { HARNESS_IDS } from '../../harness/types';
import type { HarnessKind } from '../../harness/adapter';

export interface Presence {
  /** the registry kind: 'codex', 'claude', 'acp:<id>' */
  kind: HarnessKind;
  label: string;
  vendor: string;
  tier: 'first' | 'basic';
  /** checking: being detected; a basic harness turned off or that can't run is installed, so present */
  state: 'missing' | 'present' | 'checking';
  version: string | null;
}

/** Every supported harness: first-class first, then the basic ones by label. */
export function presence(s: AppState): Presence[] {
  const first = HARNESS_IDS.map((h): Presence => {
    const st = harnessStatus(h, s);
    const info = harnessInfo(h)!;
    return {
      kind: h,
      label: info.label,
      vendor: info.vendor,
      tier: 'first',
      state: st.state === 'missing' ? 'missing' : st.state === 'detecting' && !st.idle ? 'checking' : 'present',
      version: st.version,
    };
  });
  const basic = s.basicHarnesses
    .map((b): Presence => {
      const kind: HarnessKind = `acp:${b.id}`;
      return {
        kind,
        label: b.label,
        vendor: harnessInfo(kind)?.vendor ?? '',
        tier: 'basic',
        state: b.state === 'missing' ? 'missing' : 'present',
        version: b.version,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...first, ...basic];
}

/** A selector's stable answer (a string), read back as the list. */
export const presenceKey = (s: AppState) => JSON.stringify(presence(s));
