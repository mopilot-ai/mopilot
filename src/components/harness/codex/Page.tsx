// Settings → Codex: its header, then three sections (Overview, Extensions, Advanced). Accounts and keys are
// managed in Accounts & billing.
import { useEffect, useState } from 'react';
import { useStore } from '../../../store/core';
import { codexUsable } from '../../../store/chats';
import { ensureCodex } from '../../../store/connection';
import { NeedsCodex } from '../../pages/Login';
import { HARNESS_TABS, isHarnessTab, type HarnessTab } from '../../../lib/settingsNav';
import { CloudSettings, CodexRuntime } from '../../pages/Settings';
import { Configuration, Hooks, ImportSection, Personalization } from './settings';
import { AccountCard, HarnessHeader } from '../Overview';
import { WhatWorks } from '../WhatWorks';
import { HARNESS_LABEL } from '../../../harness/types';
import { PluginSettings } from './PluginSettings';
import { HarnessTabs, ModelsAndBilling } from '../../pages/settings/HarnessPage';

export function CodexPage({ tab }: { tab?: string }) {
  const [t, setT] = useState<HarnessTab>(isHarnessTab(tab) ? tab : HARNESS_TABS[0].id);
  // the rest of these pages read and write the Codex app-server
  const ok = useStore((s) => codexUsable(s));
  useEffect(() => void ensureCodex(), []);
  return (
    <>
      <HarnessHeader h="codex" />
      <HarnessTabs value={t} onChange={setT} />
      {t === 'overview' && (
        <>
          <AccountCard h="codex" />
          <ModelsAndBilling h="codex" />
          {ok ? <Configuration part="models" /> : <NeedsCodex what="Codex’s models, memory and configuration." />}
          <Personalization />
          {/* what a chat gets once Codex runs, as a basic harness's shows once it is admitted */}
          {ok && <WhatWorks kind="codex" label={HARNESS_LABEL.codex} />}
        </>
      )}
      {t === 'extensions' &&
        (ok ? (
          <>
            <PluginSettings />
            <Hooks />
            <ImportSection />
          </>
        ) : (
          <NeedsCodex what="Codex plugins, skills, MCP servers and hooks." />
        ))}
      {t === 'advanced' && (
        <>
          <CodexRuntime />
          {ok ? (
            <>
              <Configuration part="cli" />
              <CloudSettings />
            </>
          ) : (
            <NeedsCodex what="Codex’s configuration and cloud settings." />
          )}
        </>
      )}
    </>
  );
}
