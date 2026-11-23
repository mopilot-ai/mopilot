// Settings → a basic harness's own page (#1871), in the frame Codex's and Claude Code's share: its header (mark,
// name, state, version line, Re-check), then Overview (its account and sign-in, new chats, its models, what works),
// Extensions (the MCP servers in its own settings) and Advanced (which CLI runs).
import { useState } from 'react';
import { savedDefaultHarness } from '../../../store/chats';
import { useStore } from '../../../store/core';
import { SIGNIN_WAITING, recheckBasic, type BasicHarness } from '../../../session/harness/acp';
import { selectValues } from '../../../../shared/acpMode.mjs';
import { basicAccountView } from '../../../harness/accountView';
import type { HarnessKind } from '../../../harness/adapter';
import { pickBasicBin } from '../../../session/harness/basicBin';
import { harnessInfo } from '../../../harness/registry';
import { HARNESS_TABS, type HarnessTab } from '../../../lib/settingsNav';
import { BasicBadge, BasicHarnessIcon } from '../../harnessPicker/HarnessPicker';
import { Spinner } from '../../ui/icons';
import { Group, Row } from '../../pages/Settings';
import { HarnessTabs } from '../../pages/settings/HarnessPage';
import { NewChatsUseRow } from '../AllHarnesses';
import { HarnessVersionLine } from '../HarnessVersionLine';
import { HarnessVersionRow } from '../HarnessVersionRow';
import { OwnMcpSettings } from '../OwnMcp';
import { RouteNotice } from '../RouteNotice';
import { WhatWorks } from '../WhatWorks';
import { useBasicHarness } from './useBasicHarness';

/** Model chips shown before "+N more". */
const MODELS_SHOWN = 8;

/** The models its last session offered, by the names the harness gives them (its value when it has none). */
function modelsOf(h: BasicHarness): { value: string; name: string }[] {
  const model = h.catalog?.configOptions?.find((o) => o.category === 'model');
  const out: { value: string; name: string }[] = [];
  const values = model ? selectValues(model) : (h.catalog?.models?.availableModels ?? []).map((m) => ({ value: m.modelId, name: m.name }));
  // one model listed under two groups is one chip; one with no name goes by its value
  for (const v of values as { value: unknown; name?: string | null }[]) {
    const value = String(v.value);
    if (!out.some((m) => m.value === value)) out.push({ value, name: v.name || value });
  }
  return out;
}

export function BasicHarnessPage({ h }: { h: BasicHarness }) {
  const [t, setT] = useState<HarnessTab>(HARNESS_TABS[0].id);
  const v = useBasicHarness(h);
  const kind: HarnessKind = `acp:${h.id}`;
  const manual = useStore((s) => s.prefs.acpBins?.[h.id]) ?? null;
  const isDefault = useStore((s) => savedDefaultHarness(s)) === kind;
  const models = modelsOf(h);
  const [all, setAll] = useState(false);
  const signedOut = h.state === 'signin';
  return (
    <div data-harness={h.id}>
      <div className="harness-head">
        <span className="harness-head-mark">
          <BasicHarnessIcon id={h.id} size={28} />
        </span>
        <div className="harness-head-text">
          <h1 className="settings-title harness-head-title">{h.label}</h1>
          <div className="harness-head-meta">
            <span className={`harness-dot ${v.tone}`} />
            {v.label}
            {h.state === 'admitted' && <BasicBadge id={h.id} />}
          </div>
          {/* what it needs or why it can't run; "Signed in" and "Ready" say no more than the state */}
          {v.waiting ? (
            <div className="harness-head-meta signin-waiting" role="status">
              <Spinner size={12} />
              {SIGNIN_WAITING}
            </div>
          ) : (
            h.state !== 'admitted' && (
              <div className={h.state === 'checking' ? 'harness-head-meta' : 'harness-head-warn'} data-harness-status={h.id}>
                {v.desc}
              </div>
            )
          )}
          <HarnessVersionLine kind={kind} label={h.label} binary={{ bin: h.bin, manual }} />
        </div>
        <button className="btn-pill" disabled={h.state === 'checking'} onClick={() => recheckBasic(h.id)}>
          Re-check
        </button>
      </div>
      <HarnessTabs value={t} onChange={setT} />
      {/* a sign-in under way stays open whichever tab is shown: unmounting it would end the login (#1871 review) */}
      {v.loginTerm}
      {t === 'overview' && (
        <>
          <Group title="Account">
            {/* its account is its own: it signs in and bills on its own; signing in is what a signed-out one needs */}
            <Row title={v.desc} desc={basicAccountView(h).managedNote}>
              {v.methods && v.signInButtons(signedOut || v.waiting)}
              {signedOut && !v.methods && (
                <button type="button" className="btn-pill primary" onClick={() => void recheckBasic(h.id)}>
                  Re-check
                </button>
              )}
            </Row>
          </Group>
          <Group title="Defaults">
            <RouteNotice harness={kind} label={h.label} variant="card" />
            {/* one choice for every harness, as on All harnesses (#1880); one that can't run isn't offered */}
            {(h.state === 'admitted' || isDefault) && <NewChatsUseRow own={kind} />}
            <Row
              title="Models"
              desc={
                models.length ? (
                  <span className="model-chips">
                    {(all ? models : models.slice(0, MODELS_SHOWN)).map((m) => (
                      <span key={m.value} className="model-chip">
                        {m.name}
                      </span>
                    ))}
                    {/* a harness can offer dozens: the rest on request, as the first-class pages' "+N more" */}
                    {models.length > MODELS_SHOWN && (
                      <button className="model-chip model-chip-more" aria-expanded={all} onClick={() => setAll((x) => !x)}>
                        {all ? 'Show less' : `+${models.length - MODELS_SHOWN} more`}
                      </button>
                    )}
                  </span>
                ) : (
                  'Listed after its first chat'
                )
              }
            />
          </Group>
          {h.state === 'admitted' && <WhatWorks kind={kind} label={h.label} />}
        </>
      )}
      {t === 'extensions' && (
        <Group title="MCP servers" desc={`The ones in ${h.label}'s own settings.`}>
          <OwnMcpSettings harness={h.id} />
        </Group>
      )}
      {t === 'advanced' && (
        <Group title={h.label}>
          <HarnessVersionRow
            managed={!!h.descriptor?.registry}
            kind={kind}
            label={h.label}
            name={harnessInfo(kind)?.detect.bins?.[0] ?? h.id}
            bin={h.bin}
            version={h.version}
            manual={manual}
            where={h}
            onPick={(p) => pickBasicBin(h.id, p)}
          />
        </Group>
      )}
    </div>
  );
}
