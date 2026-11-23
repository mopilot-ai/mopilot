// Settings → Built-in tools → Computer History (#1363): turning it on (the first time through the explainer), its status with Pause / Resume and what to do when it can't record, the apps and sites it may record, what it never records, and the memories by day with retention, Delete and Delete all.
import { useEffect, useState } from 'react';
import { native } from '../../../lib/native';
import { STATUS_LABEL, statusDetail, useComputerHistory } from '../../../store/computerHistory';
import { isEnter } from '../../../lib/focus';
import { errorText } from '../../../lib/ignored';
import { toastFailure } from '../../../store/core';
import type { ComputerHistoryState, ComputerHistoryStatus } from '../../../lib/native/computerHistory';
import { Group, Row, Toggle } from '../Settings';
import { Lock } from '../../ui/icons';
import { ComputerHistoryExplainer } from './ComputerHistoryExplainer';
import { ComputerHistoryDays } from './ComputerHistoryDays';
import { BUILT_IN_BROWSER } from '../../../../shared/computerHistory.mjs';

/** What the always-excluded sites are, in words; the lists themselves are in main. */
export const NEVER_SITES =
  'Banking, payment, brokerage and crypto sites; password managers and account security pages; government identity portals; health sites; sign-in pages and MoPilot; your private network.';

type Candidate = { bundleId: string; name: string; excluded: string | null };
type Change = ReturnType<typeof useComputerHistory>['change'];

/**
 * The running apps the user may add, read when the app list shows and again when the status changes (the helper that
 * lists them may have become available since).
 */
function useCandidates(status: ComputerHistoryStatus) {
  const [apps, setApps] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // the helper lists them: while it can't be reached, say so instead of asking it
    if (status === 'unavailable') return setError('Waiting for MoPilot Computer Use to list the running apps.');
    let live = true;
    native.computerHistory.candidates().then(
      (r) => {
        if (!live) return;
        if (r.ok) {
          setApps(r.apps);
          setError(null);
        } else setError(r.error);
      },
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [status]);
  return { apps, error };
}

function StatusRow({ state, change }: { state: ComputerHistoryState; change: Change }) {
  const s = state.status;
  return (
    <Row title="Status" desc={statusDetail(state)}>
      <span className="status-pill" data-status={s}>
        {STATUS_LABEL[s]}
      </span>
      {s === 'needs-permission' && (
        <button
          className="btn-pill soft"
          onClick={() =>
            native.computer
              .openSettings('accessibility')
              .then(
                (opened) => opened || toastFailure("Couldn't open System Settings")('the helper did not open it'),
                toastFailure("Couldn't open System Settings"),
              )
          }
        >
          Open System Settings
        </button>
      )}
      {s === 'paused' ? (
        <button className="btn-pill soft" onClick={() => change('resume Computer History', () => native.computerHistory.resume())}>
          Resume
        </button>
      ) : (
        <button className="btn-pill soft" onClick={() => change('pause Computer History', () => native.computerHistory.pause())}>
          Pause
        </button>
      )}
    </Row>
  );
}

function AppsGroup({ state, change }: { state: ComputerHistoryState; change: Change }) {
  const { apps, error } = useCandidates(state.status);
  const [pick, setPick] = useState('');
  const allowed = new Set(state.settings.apps.map((a) => a.bundleId));
  // the running apps only: the built-in browser is not a capture source yet, so it is not offered (#1363 follow-up)
  const choices: Candidate[] = (apps ?? []).filter(
    (a, i, all) => !allowed.has(a.bundleId) && all.findIndex((b) => b.bundleId === a.bundleId) === i,
  );
  const add = async () => {
    const app = choices.find((c) => c.bundleId === pick && !c.excluded);
    if (app && (await change(`add ${app.name}`, () => native.computerHistory.allowApp({ bundleId: app.bundleId, name: app.name }))))
      setPick('');
  };
  return (
    <Group title="Apps" desc="Only these apps are recorded. For a browser, add the sites below too.">
      {state.settings.apps.map((a) => (
        <Row key={a.bundleId} title={a.name} desc={a.bundleId === BUILT_IN_BROWSER.bundleId ? 'MoPilot' : a.bundleId}>
          <button
            className="btn-pill soft"
            aria-label={`Remove ${a.name}`}
            onClick={() => change(`remove ${a.name}`, () => native.computerHistory.removeApp(a.bundleId))}
          >
            Remove
          </button>
        </Row>
      ))}
      <Row title="Add an app" desc={error ?? 'Open the app first to see it here.'}>
        <select className="pref" aria-label="App to add" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Choose an app…</option>
          {choices.map((c) => (
            <option key={c.bundleId} value={c.bundleId} disabled={!!c.excluded}>
              {c.excluded ? `${c.name} — never recorded (${c.excluded})` : c.name}
            </option>
          ))}
        </select>
        <button className="btn-pill soft" disabled={!pick} onClick={add}>
          Add
        </button>
      </Row>
    </Group>
  );
}

function SitesGroup({ state, change }: { state: ComputerHistoryState; change: Change }) {
  const [draft, setDraft] = useState('');
  const add = async () => {
    const typed = draft;
    if (!typed.trim()) return;
    // the site stays in the box until it is added; something typed meanwhile stays too
    if (await change(`add ${typed.trim()}`, () => native.computerHistory.allowSite(typed))) setDraft((now) => (now === typed ? '' : now));
  };
  return (
    <Group title="Sites" desc="In an allowed browser, only these sites and their subdomains are recorded.">
      {state.settings.sites.map((site) => (
        <Row key={site} title={site} mono>
          <button
            className="btn-pill soft"
            aria-label={`Remove ${site}`}
            onClick={() => change(`remove ${site}`, () => native.computerHistory.removeSite(site))}
          >
            Remove
          </button>
        </Row>
      ))}
      <Row title="Add a site" desc="Such as docs.example.com or example.com.">
        <input
          className="text-input slim wide"
          aria-label="Site to add"
          placeholder="example.com"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => isEnter(e) && add()}
        />
      </Row>
    </Group>
  );
}

export function ComputerHistorySettings() {
  const { state, exclusions, error, load, change } = useComputerHistory();
  const [explain, setExplain] = useState(false);
  const warning = error && (
    <div className="config-warning" role="alert">
      Couldn't read Computer History: {error}{' '}
      <button className="btn-pill soft" onClick={() => void load()}>
        Retry
      </button>
    </div>
  );
  if (!state) return warning || null;
  const on = state.settings.enabled;
  const turnOn = async () => {
    setExplain(false);
    await change('note the explainer', () => native.computerHistory.explainerSeen());
    await change('turn on Computer History', () => native.computerHistory.setEnabled(true));
  };
  const toggle = (v: boolean) => {
    if (v && !state.settings.explainerSeen) return setExplain(true);
    return change(v ? 'turn on Computer History' : 'turn off Computer History', () => native.computerHistory.setEnabled(v));
  };
  return (
    <>
      {warning}
      <p className="settings-sub settings-lead">
        Turns what you do in the apps and sites you allow into memories on this Mac. A chat gets them only when you share them.
      </p>
      {state.settingsError && (
        <div className="config-warning" role="alert">
          {state.settingsError}
        </div>
      )}
      <Group title="Recording">
        <Row title="Record activity" desc="Off by default. Nothing outside the lists below is ever recorded.">
          <Toggle on={on} onChange={toggle} />
        </Row>
        {on && <StatusRow state={state} change={change} />}
      </Group>
      {on && <AppsGroup state={state} change={change} />}
      {on && <SitesGroup state={state} change={change} />}
      <Group title="Never recorded" desc="Whatever the lists say.">
        <Row title="Apps" desc={[...new Set((exclusions?.apps ?? []).map((a) => a.reason))].join(', ')}>
          <span className="status-pill" title="Built into MoPilot">
            <Lock size={11} />
            &nbsp;Built in
          </span>
        </Row>
        <Row title="Sites" desc={NEVER_SITES}>
          <span className="status-pill" title="Built into MoPilot">
            <Lock size={11} />
            &nbsp;Built in
          </span>
        </Row>
        <Row
          title="Passwords and secure fields"
          desc="Nothing is read while a password field has focus. Keystrokes, screenshots and field contents never are."
        />
      </Group>
      <ComputerHistoryDays state={state} change={change} />
      {explain && (
        <ComputerHistoryExplainer retentionDays={state.settings.retentionDays} onTurnOn={turnOn} onClose={() => setExplain(false)} />
      )}
    </>
  );
}
