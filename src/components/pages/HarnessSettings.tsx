// Settings → Harnesses → All harnesses: what new chats use and one row per harness (AllHarnesses); the harness
// billing rows and the instructions editor the harness pages share.
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)
import { useEffect, useState, type ReactNode } from 'react';
import { setPrefs, toast, toastFailure, useStore } from '../../store/core';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { basename } from '../../lib/paths';
import { instructionsPath } from '../../harness/instructions';
import type { HarnessKind } from '../../harness/adapter';
import { HARNESS_IDS, type HarnessId } from '../../harness/types';
import { PARTS } from '../harness/parts';
import { Group, Row, Select } from './Settings';
import { BillingRow } from './settings/BillingRow';
import { limitChoice } from '../../../shared/switch.mjs';
import { AllHarnesses } from '../harness/AllHarnesses';
import { InstallHarnesses } from '../harness/InstallHarnesses';

export { endpointLabel } from './settings/BillingRow';

/** Pay with, the API key and what happens once every account has run out, then any rows only it has. Moving between
 * accounts is the accounts list's switch (AutoSwitchRow); switching never signs anything out. */
export function HarnessBilling({ h, children }: { h: HarnessId; children?: ReactNode }) {
  // stored per harness: setting Codex never changes Claude Code's row
  const limitAsk = useStore((s) => s.prefs.limitAsk);
  const parts = PARTS[h];
  const billing = parts.useBilling();
  const [autoSwitch] = parts.useAutoSwitch();
  return (
    <Group id={`billing-${h}`}>
      <BillingRow {...billing} />
      <Row title="When every account runs out" desc="API keys and credits need your approval first.">
        <Select
          value={limitChoice(autoSwitch, limitAsk?.[h])}
          width={260}
          options={[
            { value: 'ask', label: 'Ask to use paid access' },
            { value: 'stop', label: 'Stop' },
          ]}
          onChange={(v) => setPrefs({ limitAsk: { ...limitAsk, [h]: v === 'ask' } })}
        />
      </Row>
      {children}
    </Group>
  );
}

export function HarnessSettings() {
  return (
    <>
      <AllHarnesses ids={HARNESS_IDS} />
      <InstallHarnesses />
    </>
  );
}

/** A harness's user-level instruction file (src/harness/instructions.ts), saved by main whether or not the harness runs. */
export function InstructionsEditor({ kind, rows, placeholder }: { kind: HarnessKind; rows: number; placeholder: string }) {
  const [path, setPath] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  // the file's location or contents couldn't be read: Save stays off, so a file it never read isn't overwritten
  const [readError, setReadError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setReadError(null);
    native.fs.configRoots().then(
      (roots) => live && setPath(instructionsPath(kind, roots)),
      (e) => live && setReadError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [kind]);
  useEffect(() => {
    if (!path) return;
    let live = true;
    native.fs.readText(path).then(
      (t) => {
        if (!live) return;
        setText(t ?? '');
        setSaved(t ?? '');
      },
      (e) => live && setReadError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [path]);
  return (
    <div className="settings-pad">
      <textarea
        className="text-area"
        rows={rows}
        value={text ?? ''}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label={path ? `Edit ${basename(path)}` : 'Instructions'}
      />
      <div className="settings-actions">
        {readError && <span className="settings-row-desc">Couldn't read the instructions: {readError}</span>}
        {path && <span className="settings-path">{path.replace(/^\/Users\/[^/]+/, '~')}</span>}
        <button
          className="btn primary sm"
          disabled={text === null || text === saved || !path || !!readError}
          onClick={async () => {
            // enabled only once the file is loaded (text !== null) and a path is known
            const r = await native.fs.writeText(path!, text!).catch((e: unknown) => {
              toastFailure(`Couldn't save ${basename(path!)}`)(e);
              return null;
            });
            if (!r) return;
            if (!r.ok) return toast(`Couldn't save ${basename(path!)}: ${r.error}`, 'error');
            setSaved(text!);
            toast('Saved');
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
