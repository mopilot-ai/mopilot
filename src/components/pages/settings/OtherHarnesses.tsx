// Settings → Other harnesses: the basic tier (one generic ACP adapter plus a quirks file each). Installed harnesses
// first, one line each with their state and what they need, opening onto sign-in and CLI location; the ones not
// installed after, as a short list with where to get them.
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)
import { useEffect, useState } from 'react';
import { savedDefaultHarness } from '../../../store/chats';
import { useStore } from '../../../store/core';
import { SIGNIN_WAITING, recheckBasic, useFreshBasics, type BasicHarness } from '../../../session/harness/acp';
import { harnessInfo } from '../../../harness/registry';
import { openLink } from '../../../session/open';
import { BasicBadge, BasicHarnessIcon } from '../../harnessPicker/HarnessPicker';
import { BinPathRow, Group, Row } from '../Settings';
import { NewChatsUseRow } from '../../harness/AllHarnesses';
import type { HarnessKind } from '../../../harness/adapter';
import { ChevronDown, ChevronUp, Spinner } from '../../ui/icons';
import { HarnessVersionRow } from '../../harness/HarnessVersionRow';
import { pickBasicBin } from '../../../session/harness/basicBin';
import { refreshInstallTools } from '../../../session/harness/harnessRuns';
import { installLines } from '../../../../shared/harnessInstall.mjs';
import { platform } from '../../../lib/platform';
import { InstallLines } from '../../harness/InstallLines';
import { HarnessVersionLine } from '../../harness/HarnessVersionLine';
import { UpdatePill, useHarnessUpdate } from '../../harness/HarnessUpdate';
import { checkHarnessUpdates } from '../../../harness/harnessUpdates';
import { WhatWorks } from '../../harness/WhatWorks';
import { basicAccountView } from '../../../harness/accountView';
import { OwnMcpSettings } from '../../harness/OwnMcp';
import { useBasicHarness } from '../../harness/basic/useBasicHarness';
import { BasicHarnessPage } from '../../harness/basic/Page';
import { RegistryAgents } from '../../harness/RegistryAgents';
import { DIRECTORY_PATH } from '../../../lib/registryCopy';

/** Not-installed harnesses listed before the rest fold behind Show all. */
const AVAILABLE_SHOWN = 4;

/** An installed basic harness on the list: one line with its state and what it needs, opening onto its details. */
function InstalledRow({ h }: { h: BasicHarness }) {
  const [open, setOpen] = useState(false);
  const { label, tone, desc, methods, waiting, signInButtons, loginTerm } = useBasicHarness(h);
  const manual = useStore((s) => s.prefs.acpBins?.[h.id]);
  const info = harnessInfo(`acp:${h.id}`);
  const saved = useStore((s) => savedDefaultHarness(s));
  const kind: HarnessKind = `acp:${h.id}`;
  const isDefault = saved === kind;
  // An update is offered only when the version check found one.
  const u = useHarnessUpdate(kind, h.label);
  return (
    <div className={`basic-row ${open ? 'open' : ''}`} data-harness={h.id}>
      <div className="basic-row-main">
        <BasicHarnessIcon id={h.id} size={22} />
        <div className="basic-row-text">
          <div className="basic-row-name">
            {h.label}
            <span className={`harness-dot ${tone}`} />
            <span className="basic-row-state">{label}</span>
            {h.state === 'admitted' && <BasicBadge id={h.id} />}
          </div>
          <div className={h.state === 'signin' ? 'basic-row-desc full' : 'basic-row-desc'} data-harness-status={h.id}>
            {waiting ? (
              <span className="signin-waiting" role="status">
                <Spinner size={12} />
                {SIGNIN_WAITING}
              </span>
            ) : (
              desc
            )}
          </div>
        </div>
        {/* signing in is what a signed-out harness needs, so it is on the row itself; so is Cancel while one waits,
            whatever a check under way makes the harness read. One set up outside is checked again */}
        {(h.state === 'signin' || waiting) && methods && signInButtons(true)}
        {h.state === 'unsupported' && u && <UpdatePill u={u} />}
        {h.state === 'signin' && !methods && (
          <button type="button" className="btn-pill primary" onClick={() => void recheckBasic(h.id)}>
            Re-check
          </button>
        )}
        <button
          type="button"
          className="btn-pill icon"
          aria-expanded={open}
          aria-label={open ? `Hide ${h.label} details` : `Show ${h.label} details`}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {open && (
        <div className="basic-row-details">
          {(h.state === 'admitted' || isDefault) && (
            // one choice for every harness, as on All harnesses (#1880)
            <NewChatsUseRow own={kind} />
          )}
          {h.state !== 'signin' && !waiting && (
            // its account is its own, whichever state it is in; the ways it signs in, when it has any
            <Row title="Account" desc={basicAccountView(h).managedNote}>
              {methods && signInButtons(false)}
            </Row>
          )}
          {h.state !== 'missing' && <OwnMcpSettings harness={h.id} />}
          {h.state === 'admitted' && <WhatWorks kind={kind} label={h.label} inline />}
          <HarnessVersionRow
            managed={!!h.descriptor?.registry}
            kind={kind}
            label={h.label}
            name={info?.detect.bins?.[0] ?? h.id}
            bin={h.bin}
            version={h.version}
            manual={manual ?? null}
            where={h}
            onPick={(v) => pickBasicBin(h.id, v)}
            // no page header to carry it: how it updates, and its update when its install channel has one
            footer={<HarnessVersionLine kind={kind} label={h.label} binary={{ bin: h.bin, manual: manual ?? null }} version={false} />}
          />
          <div className="basic-row-foot">
            <button className="btn-pill" disabled={h.state === 'checking'} onClick={() => recheckBasic(h.id)}>
              Re-check
            </button>
          </div>
        </div>
      )}
      {loginTerm}
    </div>
  );
}

/** A harness that is not installed: who makes it, its install commands to copy or run, and its docs; a location can
 * be set if it lives elsewhere. */
function AvailableRow({ h }: { h: BasicHarness }) {
  const [open, setOpen] = useState(false);
  const manual = useStore((s) => s.prefs.acpBins?.[h.id]);
  const kind: HarnessKind = `acp:${h.id}`;
  const info = harnessInfo(kind);
  const item = { kind, label: h.label, vendor: info?.vendor ?? '', tier: 'basic' as const, state: 'missing' as const, version: null };
  // with no command for this OS, the vendor's page is where to get it
  const commands = installLines(kind, platform, null).length > 0;
  return (
    <div className="basic-row" data-harness={h.id}>
      <div className="basic-row-main">
        <BasicHarnessIcon id={h.id} size={22} />
        <div className="basic-row-text">
          <div className="basic-row-name">{h.label}</div>
          <div className="basic-row-desc" data-harness-status={h.id}>
            {info?.vendor ?? 'Not found on your PATH'}
          </div>
        </div>
        {!h.descriptor?.registry && (
          <button type="button" className="text-link basic-row-link" onClick={() => setOpen(!open)}>
            {open ? 'Done' : 'Set location…'}
          </button>
        )}
        {info?.install.docs && (
          <button type="button" className="text-link basic-row-link" onClick={() => openLink(info.install.docs)}>
            {commands ? 'Docs ↗' : `Get it from ${info.vendor} ↗`}
          </button>
        )}
      </div>
      {commands && <InstallLines item={item} onSetLocation={() => setOpen(true)} />}
      {h.descriptor?.registry && <p className="basic-row-desc">Install again in {DIRECTORY_PATH} to restore this agent.</p>}
      {open && (
        <div className="basic-row-details">
          <BinPathRow name={info?.detect.bins?.[0] ?? h.id} value={manual ?? null} onChange={(v) => pickBasicBin(h.id, v)} />
        </div>
      )}
    </div>
  );
}

export function OtherHarnesses({ harnessId }: { harnessId?: string }) {
  useFreshBasics();
  // what the install lines need (npm, Homebrew), and each installed harness's version and update, asked when the page opens
  useEffect(() => {
    refreshInstallTools();
    void checkHarnessUpdates();
  }, []);
  const list = useStore((s) => s.basicHarnesses);
  const [all, setAll] = useState(false);
  const order = { admitted: 0, signin: 1, checking: 2, unsupported: 3, off: 4, missing: 5 };
  const sorted = [...list].sort((a, b) => order[a.state] - order[b.state] || a.label.localeCompare(b.label));
  const installed = sorted.filter((h) => h.state !== 'missing');
  const available = sorted.filter((h) => h.state === 'missing');
  const shown = all ? available : available.slice(0, AVAILABLE_SHOWN);
  const hidden = available.slice(AVAILABLE_SHOWN);
  const selected = list.find((h) => h.id === harnessId);
  if (selected) {
    return (
      <div className="other-harnesses">
        {selected.state === 'missing' ? (
          <AvailableRow key={selected.id} h={selected} />
        ) : (
          <BasicHarnessPage key={selected.id} h={selected} />
        )}
      </div>
    );
  }
  return (
    <div className="other-harnesses">
      <p className="settings-lead">
        Each agent signs in and bills on its own; available tools and features depend on the agent and this computer.
      </p>
      <RegistryAgents />
      {installed.length > 0 && (
        <Group title="Installed">
          {installed.map((h) => (
            <InstalledRow key={h.id} h={h} />
          ))}
        </Group>
      )}
      {available.length > 0 && (
        <Group
          title="Available to install"
          desc="Run a command here or in your own terminal. MoPilot picks the harness up once it's installed."
          action={
            <button className="btn-pill" onClick={() => recheckBasic()}>
              Re-check
            </button>
          }
        >
          {shown.map((h) => (
            <AvailableRow key={h.id} h={h} />
          ))}
          {hidden.length > 0 && (
            <div className="basic-row-foot spread">
              <span>{all ? '' : `+ ${hidden.map((h) => h.label).join(', ')}`}</span>
              <button type="button" className="text-link" onClick={() => setAll(!all)}>
                {all ? 'Show fewer' : 'Show all'}
              </button>
            </div>
          )}
        </Group>
      )}
    </div>
  );
}
