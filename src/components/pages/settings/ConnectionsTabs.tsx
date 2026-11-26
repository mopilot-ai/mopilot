// Settings › Connections, split by direction like the reference's page: Control this Mac (who may control it), Control other devices (the machines this Mac controls), and SSH (this Mac's ssh connections). The tab is the settings route's own tab, so a link can open one; a missing or unknown tab is the first.
import { useEffect, useState } from 'react';
import { native } from '../../../lib/native';
import { useFlag } from '../../../lib/flags';
import { ignoring } from '../../../lib/ignored';
import { useHostAccess, useHostAnswered } from '../../../lib/host';
import { CONNECTION_TABS, connectionsRoute } from '../../../lib/connectionsRoute';
import { navigate } from '../../../store/panes';
import { HostMachines } from './HostMachines';
import { SshConnections } from './Connections';
import { CodexClientRows, CodexSwitchRows, codexLinkOff, useCodexControl } from './RemoteControl';
import { MobileRemote } from './MobileRemote';
import { MobileRemoteAlwaysOn } from './MobileRemoteAlwaysOn';

/** How long the strip waits for main's answer on Host before it shows what it has. */
const HOST_WAIT_MS = 3000;

/** True once `ms` have passed since the first render. */
function useWaited(ms: number): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDone(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return done;
}

/** The tab strip and the one tab's page; `tab` is the settings route's tab. */
export function ConnectionsTabs({ tab: raw }: { tab: string | undefined }) {
  const host = useHostAccess();
  // main's answer on Host, or the end of the wait for it: a read that never comes back does not hold the strip for ever
  const hostAnswered = useHostAnswered();
  const waited = useWaited(HOST_WAIT_MS);
  const answered = hostAnswered || waited;
  // the machines tab needs Host for this account: without it the strip does not offer it and a link to it lands on the first tab
  const tabs = CONNECTION_TABS.filter((t) => t.id !== 'other' || host);
  // until the answer is known the route's own tab shows (a link to Control other devices opens it at once); after it, one that does not exist falls back to the first
  const tab = (answered ? tabs : CONNECTION_TABS).find((t) => t.id === raw)?.id ?? tabs[0].id;
  return (
    <>
      {/* the strip keeps its place while main has not answered on Host and shows no tab then: it never shows a tab and takes it away */}
      <div className="conn-tabs" role="tablist" aria-label="Connections">
        {answered &&
          tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`ps-tab ${tab === t.id ? 'on' : ''}`}
              onClick={() => navigate(connectionsRoute(t.id))}
            >
              {t.label}
            </button>
          ))}
      </div>
      {tab === 'this-mac' && <ControlThisMac />}
      {tab === 'other' && <HostMachines />}
      {tab === 'ssh' && <SshConnections />}
    </>
  );
}

/** Control this Mac: the devices that may control it (phones, and the ChatGPT devices of Codex's Remote Control, one list), then Other settings. Codex's rows are there only where Codex is usable; the tab never needs it. */
function ControlThisMac() {
  const codex = useCodexControl();
  // ChatGPT's link counts as on while it is up or coming up: the one switch reads on for it and turns it off with the phones
  const linkOn = codex.usable && (codex.connected || codex.view?.status === 'connecting' || codex.view?.retrying === true);
  const weakKey = useWeakApprovalKey();
  return (
    <>
      <MobileRemote
        extra={<CodexClientRows control={codex} />}
        extraVisible={codex.usable && codex.connected}
        linkOn={linkOn}
        alsoOff={linkOn ? codexLinkOff : undefined}
        otherSwitch={codex.usable}
        weakKey={weakKey}
      />
      <MobileRemoteAlwaysOn extra={<CodexSwitchRows control={codex} />} extraVisible={codex.usable} />
    </>
  );
}

/** Whether this Mac's own approval key for pairing by code is in software (status.approval.weak), read once while pairing by code is on. */
function useWeakApprovalKey(): boolean {
  const on = useFlag('host.codePair');
  const [weak, setWeak] = useState(false);
  useEffect(() => {
    if (!on) return;
    let live = true;
    Promise.resolve()
      .then(() => native.codePair.status())
      .then((s) => live && setWeak(s.approval.weak === true), ignoring('read whether this Mac’s approval key is weak'));
    return () => {
      live = false;
    };
  }, [on]);
  return on && weak;
}
