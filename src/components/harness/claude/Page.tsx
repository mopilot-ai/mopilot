// Settings → Claude Code: its header, then three sections (Overview, Extensions, Advanced). Accounts and keys are
// managed in Accounts & billing.
import { useState } from 'react';
import { HARNESS_TABS, isHarnessTab, type HarnessTab } from '../../../lib/settingsNav';
import { useHarnessStatus } from '../../../session/harness/select';
import { Group, Row } from '../../pages/Settings';
import { InstructionsEditor } from '../../pages/HarnessSettings';
import { HarnessTabs, ModelsAndBilling } from '../../pages/settings/HarnessPage';
import { AccountCard, HarnessHeader } from '../Overview';
import { WhatWorks } from '../WhatWorks';
import { HARNESS_LABEL } from '../../../harness/types';
import { ClaudeAdvanced } from './parts';
import { ClaudeExtensions } from './Extensions';

export function ClaudePage({ tab }: { tab?: string }) {
  const [t, setT] = useState<HarnessTab>(isHarnessTab(tab) ? tab : HARNESS_TABS[0].id);
  const st = useHarnessStatus('claude');
  // the editor opens on demand, as Codex's does
  const [editing, setEditing] = useState(false);
  return (
    <>
      <HarnessHeader h="claude" />
      <HarnessTabs value={t} onChange={setT} />
      {t === 'overview' && (
        <>
          <AccountCard h="claude" />
          <ModelsAndBilling h="claude" />
          <Group title="Instructions">
            <Row title="CLAUDE.md" desc="Your instructions for every chat. Project instructions also apply.">
              <button className="btn-pill" onClick={() => setEditing((e) => !e)}>
                {editing ? 'Done' : 'Edit'}
              </button>
            </Row>
            {editing && <InstructionsEditor kind="claude" rows={12} placeholder="e.g. Prefer small, reviewable diffs." />}
          </Group>
          {/* what a chat gets once Claude Code runs, as a basic harness's shows once it is admitted */}
          {(st.state === 'ready' || st.state === 'apikey') && <WhatWorks kind="claude" label={HARNESS_LABEL.claude} />}
        </>
      )}
      {t === 'extensions' &&
        ((st.state === 'ready' || st.state === 'apikey') && st.bin ? (
          <ClaudeExtensions bin={st.bin} />
        ) : (
          <Group title="Extensions">
            <Row title="Available once Claude Code is installed and signed in" />
          </Group>
        ))}
      {t === 'advanced' && <ClaudeAdvanced />}
    </>
  );
}
