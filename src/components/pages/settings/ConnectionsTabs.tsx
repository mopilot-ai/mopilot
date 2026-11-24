// Settings › Connections, split by direction like the reference's page: Control this Mac (who may control it), Control other devices (the machines this Mac controls), and SSH (this Mac's ssh connections). The tab is the settings route's own tab, so a link can open one; a missing or unknown tab is the first.
import { useHostAccess } from '../../../lib/host';
import { CONNECTION_TABS, connectionsRoute } from '../../../lib/connectionsRoute';
import { navigate } from '../../../store/panes';
import { HostMachines } from './HostMachines';
import { SshConnections } from './Connections';
import { CodexClientRows, CodexSwitchRows, codexLinkOff, useCodexControl } from './RemoteControl';
import { MobileRemote } from './MobileRemote';
import { MobileRemoteAlwaysOn } from './MobileRemoteAlwaysOn';

/** The tab strip and the one tab's page; `tab` is the settings route's tab. */
export function ConnectionsTabs({ tab: raw }: { tab: string | undefined }) {
  const host = useHostAccess();
  // the machines tab needs Host for this account: without it the strip does not offer it and a link to it lands on the first tab
  const tabs = CONNECTION_TABS.filter((t) => t.id !== 'other' || host);
  const tab = tabs.find((t) => t.id === raw)?.id ?? tabs[0].id;
  return (
    <>
      <div className="conn-tabs" role="tablist" aria-label="Connections">
        {tabs.map((t) => (
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
  return (
    <>
      <MobileRemote
        extra={<CodexClientRows control={codex} />}
        extraVisible={codex.usable && codex.connected}
        linkOn={linkOn}
        alsoOff={linkOn ? codexLinkOff : undefined}
      />
      <MobileRemoteAlwaysOn extra={<CodexSwitchRows control={codex} />} extraVisible={codex.usable} />
    </>
  );
}
