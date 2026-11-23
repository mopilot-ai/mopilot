// "What works in MoPilot" on a harness's page (#1385): a plain checklist of what a new chat on that harness gets,
// each item a ✓ or why not and what to do instead. Harness-neutral: the items come from src/session/harness/whatWorks.ts.
import type { HarnessKind } from '../../harness/adapter';
import { useHarnessCaps, whatWorks } from '../../session/harness/whatWorks';
import { navigate } from '../../store/panes';
import { useStore } from '../../store/core';
import { useNativeAvailability } from '../../session/nativeAvailability';
import { Group } from '../pages/Settings';
import { Check, Minus } from '../ui/icons';

const TITLE = 'What works in MoPilot';

/** `inline`: inside a basic harness's details (Settings → Other harnesses), under a heading of its own. */
export function WhatWorks({ kind, label, inline = false }: { kind: HarnessKind; label: string; inline?: boolean }) {
  const caps = useHarnessCaps(kind);
  const basic = useStore((s) => s.basicHarnesses.find((h) => `acp:${h.id}` === kind));
  // computer use on this Mac, as Settings → Computer use shows it for this harness
  const status = useNativeAvailability();
  // nothing is claimed until main answers
  if (!caps) return null;
  const list = (
    <ul className="works-list" aria-label={TITLE} data-works={kind}>
      {whatWorks(caps, label, basic, status?.harnesses.find((h) => h.harness === caps.family)?.computer).map((i) => (
        <li key={i.id} className={`works-item ${i.ok ? 'ok' : 'off'}`} data-work={i.id}>
          {i.ok ? (
            <Check size={15} role="img" aria-label="Works" className="works-mark" />
          ) : (
            <Minus size={15} role="img" aria-label="Not available" className="works-mark" />
          )}
          <span className="works-text">
            {i.text}
            {i.note && <span className="works-note">{i.note}</span>}
            {i.action && (
              <button type="button" className="text-link" onClick={() => navigate({ name: 'settings', section: i.action! })}>
                Open Computer use settings
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
  if (inline)
    return (
      <div className="works-inline">
        <div className="works-inline-title">{TITLE}</div>
        {list}
      </div>
    );
  return <Group title={TITLE}>{list}</Group>;
}
