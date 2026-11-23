// Settings → Built-in tools → Computer use: the helper's macOS permissions (with the first-use guide),
// brief switching for background control, the apps each chat and every chat may control, the apps it never
// controls, and the engine version. Whether computer use can work comes from main's capability health record
// (electron/capabilities/capabilityHealth.cjs), never from the permission rows alone.
import { capabilityReasonText } from '../../../../shared/capabilityReasons.mjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { native, type ComputerPermission, type ComputerStatus, type ComputerGrant, type NativeSetupAction } from '../../../lib/native';
import { useStore, threadTitle, toastFailure } from '../../../store/core';
import { Group, Row } from '../Settings';
import { Toggle } from './Controls';
import { Lock, MousePointerClick } from '../../ui/icons';
import { isEnter } from '../../../lib/focus';
import { NativeControlStatus } from './NativeControlStatus';
import { GrantRow, MachineGroups } from './MachineGroups';
import { errorText } from '../../../lib/ignored';
import { copy } from '../../../harness/copy';

const PERMISSIONS: { id: ComputerPermission; title: string; desc: string }[] = [
  { id: 'accessibility', title: 'Accessibility', desc: 'Click, type, and stop with Esc.' },
  { id: 'screenRecording', title: 'Screen Recording', desc: 'See your screen.' },
  { id: 'inputMonitoring', title: 'Input Monitoring', desc: 'Optional: pause when you take over.' },
];

export function ComputerUseSettings() {
  const [st, setSt] = useState<ComputerStatus | null>(null);
  // why the last read failed: shown with Retry (over the last status, if there is one); onChanged and focus read again too
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // the permission the newest Request left off: macOS may show no prompt (a stale grant for an older helper
  // build), so its row says it is still off and what to do next instead of changing nothing
  const [stillOff, setStillOff] = useState<ComputerPermission | null>(null);
  const asks = useRef(0);
  const threads = useStore((s) => s.threads);
  const initialTitles = useStore((s) => s.chatInitialTitles);
  const load = useCallback(
    () =>
      native.computer.status().then(
        (status) => {
          setSt(status);
          setError(null);
        },
        (e: unknown) => setError(errorText(e)),
      ),
    [],
  );
  useEffect(() => {
    // cannot reject: load shows a failed read with Retry
    void load();
    const off = native.computer.onChanged(() => void load());
    // permissions change in System Settings: look again when the window comes back
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);
  const warning = error && (
    <div className="config-warning" role="alert">
      Couldn't read the computer use status: {error}{' '}
      <button className="btn-pill soft" onClick={() => void load()}>
        Retry
      </button>
    </div>
  );
  if (!st) return warning || null;
  if (!st.enabled)
    return (
      <>
        {warning}
        <p className="settings-sub settings-lead">Computer use is unavailable.</p>
        <NativeControlStatus surface="computer" />
      </>
    );

  const health = st.health ?? null;
  const open = (kind: ComputerPermission) => {
    // main answers false when the helper couldn't open the pane
    native.computer
      .openSettings(kind)
      .then(
        (opened) => opened || toastFailure("Couldn't open System Settings")('the computer use helper did not open it'),
        toastFailure("Couldn't open System Settings"),
      );
  };
  // the health record's fix: a permission's pane, or reading the status again (which starts the helper)
  const fix = (f: NativeSetupAction | null) => {
    if (f?.kind === 'computerPermission') open(f.permission);
    else void load();
  };
  /**
   * A change the user asked for, then the status read again either way. One that fails says so: an app still
   * allowed must not look removed. True when it went through.
   */
  const change = async (what: string, run: () => Promise<unknown>) => {
    let done = true;
    try {
      await run();
    } catch (e) {
      done = false;
      toastFailure(`Couldn't ${what}`)(e);
    }
    await load();
    return done;
  };
  /** Request permission: main answers whether it is on now; one left off says so on its row (descOf). */
  const request = async (kind: ComputerPermission) => {
    const ask = ++asks.current;
    setStillOff(null);
    let on: boolean | null = null;
    try {
      on = await native.computer.requestPermission(kind);
    } catch (e) {
      toastFailure("Couldn't request the permission")(e);
    }
    await load();
    if (on === false && ask === asks.current) setStillOff(kind);
  };
  // a row's description, with "still off" and the next step while the status reads off what a Request left off
  const descOf = (p: (typeof PERMISSIONS)[number]) =>
    stillOff === p.id && st.permissions?.[p.id] === false ? (
      <>
        {p.desc}{' '}
        <span className="cu-permission-still" role="status">
          {copy('computerUse', 'permissionStillOff', { Permission: p.title })}
        </span>
      </>
    ) : (
      p.desc
    );
  const revoke = (chatId: string | null, g: ComputerGrant) => change(`remove ${g.name}`, () => native.computer.revoke(chatId, g.bundleId));
  // the always-allowed apps: future requests in any chat ask again; chats keep what they were granted
  const revokeAll = () => change('remove the always-allowed apps', () => native.computer.revokeAll());
  const addDeny = async () => {
    const typed = draft;
    const id = typed.trim();
    if (!id) return;
    // the bundle ID stays in the box until it is blocked, and something typed meanwhile stays too
    if (await change(`block ${id}`, () => native.computer.setDeny([...st.deny.user, id]))) setDraft((now) => (now === typed ? '' : now));
  };
  return (
    <>
      {warning}
      <NativeControlStatus surface="computer" />
      {health && ['unavailable', 'error', 'permission'].includes(health.state) && (
        <div className="cu-guide" role="note" data-state={health.state}>
          <span className="cu-guide-icon">
            <MousePointerClick size={18} strokeWidth={1.6} />
          </span>
          <div className="cu-guide-text">
            {capabilityReasonText(health.reasonCode)}
            {health.state === 'permission' && ' Agents can only control apps you approve.'}
          </div>
          {health.fix && (
            <button className="btn-pill" onClick={() => fix(health.fix)}>
              {health.fix.label}
            </button>
          )}
        </div>
      )}
      <Group title="Permissions">
        {PERMISSIONS.map((p) => (
          <Row key={p.id} title={p.title} desc={descOf(p)}>
            {st.permissions?.[p.id] ? (
              <span className="status-pill">Allowed</span>
            ) : (
              <>
                {/* not known while the helper isn't running: no request (it needs the helper), but the pane opens */}
                {st.permissions ? (
                  <button className="btn-pill soft" aria-label={`Request ${p.title} permission`} onClick={() => request(p.id)}>
                    Request permission
                  </button>
                ) : (
                  <span className="status-pill unknown">Unknown</span>
                )}
                <button className="btn-pill soft" aria-label={`Open System Settings for ${p.title}`} onClick={() => open(p.id)}>
                  Open System Settings
                </button>
              </>
            )}
          </Row>
        ))}
      </Group>
      <Group title="Background control">
        <Row
          title="Allow brief switching to the app when background control doesn't work"
          desc="The app comes forward for one action, then steps back."
        >
          <Toggle
            on={st.briefForeground !== false}
            onChange={(v) => change('change brief switching', () => native.computer.setBriefForeground(v))}
          />
        </Row>
        <Row title="Use Codex Computer Use in Codex chats" desc="Off: MoPilot’s computer use, which is faster. For new chats.">
          <Toggle
            on={st.codexNativeComputer === true}
            onChange={(v) => change('change Codex computer use', () => native.computer.setCodexNativeComputer(v))}
          />
        </Row>
      </Group>
      <Group
        title="Always allowed"
        desc="Every chat can use these without asking."
        action={
          st.grants.global.length ? (
            <button className="btn-pill soft" onClick={revokeAll}>
              Remove all
            </button>
          ) : undefined
        }
      >
        {st.grants.global.length ? (
          st.grants.global.map((g) => <GrantRow key={g.bundleId} g={g} onRemove={() => revoke(null, g)} />)
        ) : (
          <Row title="No apps yet" desc="Choose Always allow on a request to add one" />
        )}
      </Group>
      <Group title="Allowed in a chat" desc="Available to the named chat.">
        {st.grants.chats.length ? (
          st.grants.chats.flatMap(({ chatId, grants }) =>
            grants.map((g) => (
              <GrantRow
                key={`${chatId}:${g.bundleId}`}
                g={g}
                chat={threadTitle(threads[chatId], initialTitles) || chatId}
                onRemove={() => revoke(chatId, g)}
              />
            )),
          )
        ) : (
          <Row title="No apps yet" desc="Choose Allow in this chat on a request to add one" />
        )}
      </Group>
      <MachineGroups machines={st.machines ?? []} chatTitle={(id) => threadTitle(threads[id], initialTitles) || id} change={change} />
      <Group title="Blocked apps" desc="Agents cannot see or control these apps.">
        {st.deny.builtIn.map((d) => (
          <Row key={d.pattern} title={d.reason} desc={d.pattern}>
            <span className="status-pill" title="Built into MoPilot">
              <Lock size={11} />
              &nbsp;Built in
            </span>
          </Row>
        ))}
        {st.deny.user.map((id) => (
          <Row key={id} title={id} desc="Added by you" mono>
            <button
              className="btn-pill soft"
              onClick={() => change(`unblock ${id}`, () => native.computer.setDeny(st.deny.user.filter((x) => x !== id)))}
            >
              Remove
            </button>
          </Row>
        ))}
        <Row title="Block another app" desc="Enter a bundle ID, such as com.example.app or com.example.*.">
          <input
            className="text-input slim wide"
            aria-label="Bundle ID to block"
            placeholder="com.example.app"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => isEnter(e) && addDeny()}
          />
        </Row>
      </Group>
      <Group title="Engine">
        <Row title="MoPilot Computer Use" desc={engineText(st)}>
          <span className="status-pill">{st.helper.version ?? '—'}</span>
        </Row>
      </Group>
    </>
  );
}

/** The engine row uses safe capability copy; helper paths and raw errors stay in Copy diagnostics. */
export function engineText(st: ComputerStatus): string {
  return st.helper.running
    ? 'Running'
    : st.health && st.health.state !== 'ready' && st.health.state !== 'unknown'
      ? capabilityReasonText(st.health.reasonCode)
      : 'Starts when an agent first uses it';
}
