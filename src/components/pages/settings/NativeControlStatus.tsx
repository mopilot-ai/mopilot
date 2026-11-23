// Settings → Browser and Computer use: how each harness reaches Chrome or the computer on this Mac. The
// vendor's own path when its runtime is installed, MoPilot's as a fallback, or unavailable with the
// step that fixes it inside MoPilot (electron/capabilities/nativeAvailability.cjs): System Settings
// panes for Codex Computer Use's permissions, and Try again / Check again; never another vendor app. On the Browser page the Claude Code row
// also carries Claude in Chrome's live link in open chats (BU-07): connected or not, which browser,
// Reconnect, and Select browser when more than one is paired. On the Browser page, where MoPilot's own Chrome
// extension serves Chrome, it is the one row for every harness (#1632): its state and its one next step; a harness
// shows a row of its own only while it uses its vendor's Chrome instead (Claude in Chrome, the ChatGPT extension).
import { capabilityReasonText } from '../../../../shared/capabilityReasons.mjs';
import { useState } from 'react';
import { useEffectOn } from '../../../lib/effects';
import { native, type NativeSetupAction, type NativeSurfaceStatus, type PairedBrowser } from '../../../lib/native';
import { isChromeExtensionAction, runChromeExtensionAction } from '../../../session/chromeExtensionActions';
import { chromeLinkSummary, useChromeLinks, useNativeAvailability, type ChromeLinkSummary } from '../../../session/nativeAvailability';
import { navigate } from '../../../store/panes';
import { setPrefs, toast, toastFailure, useStore } from '../../../store/core';
import { errorText } from '../../../lib/ignored';
import { openLink } from '../../../session/open';
import { Group, Row } from '../Settings';

const SURFACE = { chrome: 'Chrome', computer: 'Computer' } as const;

export function NativeControlStatus({ surface }: { surface: 'chrome' | 'computer' }) {
  const status = useNativeAvailability(true);
  const links = useChromeLinks(surface === 'chrome');
  const prefs = useStore((s) => s.prefs);
  if (!status) return null;
  const own = surface === 'chrome' ? status.extension : null;
  const run = (a: NativeSetupAction) => {
    if (a.kind === 'url') openLink(a.url);
    else if (a.kind === 'retry') native.availability.retry().catch(toastFailure("Couldn't check again"));
    else if (a.kind === 'settings') navigate({ name: 'settings', section: a.section });
    // main answers false when the helper couldn't open the pane
    else if (a.kind === 'computerPermission')
      native.computer
        .openSettings(a.permission)
        .then(
          (opened) => opened || toastFailure("Couldn't open System Settings")('the computer use helper did not open it'),
          toastFailure("Couldn't open System Settings"),
        );
    // reading the computer use status starts the helper again; its outcome reaches this row through onChanged
    else if (a.kind === 'computerCheck') native.computer.status().catch(toastFailure("Couldn't check computer use again"));
    // MoPilot's own extension: the same steps as on the welcome page
    else if (isChromeExtensionAction(a)) runChromeExtensionAction(a);
    else {
      // Your Chrome: the same switch as "Browser for agents" (the setting changes once main switched), then its setup
      native.browser.configure({ channel: 'chrome', profileDir: prefs.chromeProfileDir }).then(() => {
        setPrefs({ browserChannel: 'chrome' });
        navigate({ name: 'settings', section: 'browser' });
      }, toastFailure("Couldn't switch to Your Chrome"));
    }
  };
  return (
    <Group
      title={own ? 'Chrome' : 'Agent control by harness'}
      desc={
        own
          ? 'How agents use your Chrome.'
          : `How each harness controls ${surface === 'chrome' ? 'your Chrome' : 'your computer'} on this ${status.platform === 'darwin' ? 'Mac' : 'computer'}.`
      }
    >
      {own && <ExtensionRow s={own} run={run} />}
      {status.harnesses.map((h) => {
        const s = h[surface];
        // MoPilot's extension's row speaks for every harness it serves: only a vendor route in use gets its own
        if (own && s.state !== 'native') return null;
        // a route whose extension link is read from the chats that run it (Claude in Chrome)
        const live = surface === 'chrome' && s.linkStatus && s.state === 'native' ? chromeLinkSummary(links) : null;
        const desc = [(s.reasonCode || s.detail) && capabilityReasonText(s.reasonCode), live?.text, s.version && `${s.version}.`]
          .filter(Boolean)
          .join(' ');
        return (
          <Row key={h.harness} title={`${h.label} · ${SURFACE[surface]}`} desc={desc || undefined}>
            <span
              className={`status-pill native-status ${s.state === 'native' || s.state === 'mopilot' ? 'ok' : s.state}`}
              data-state={s.state}
            >
              {s.label}
            </span>
            {s.actions.map((a) => (
              <button key={a.label} className="btn-pill soft" onClick={() => run(a)}>
                {a.label}
              </button>
            ))}
            {live && <ClaudeChromeLink live={live} />}
          </Row>
        );
      })}
    </Group>
  );
}

/** MoPilot's own Chrome extension, for every harness it serves: connected or what it needs, and its fixes. */
function ExtensionRow({ s, run }: { s: NativeSurfaceStatus; run: (a: NativeSetupAction) => void }) {
  return (
    <Row title="MoPilot extension" desc={s.reasonCode ? capabilityReasonText(s.reasonCode) : undefined}>
      <span className={`status-pill native-status ${s.state === 'mopilot' ? 'ok' : s.state}`} data-state={s.state}>
        {s.label}
      </span>
      {s.actions.map((a) => (
        <button key={a.label} className="btn-pill soft" onClick={() => run(a)}>
          {a.label}
        </button>
      ))}
    </Row>
  );
}

/** Reconnect for the chats whose link is down; the browser picker while more than one is paired. */
function ClaudeChromeLink({ live }: { live: ChromeLinkSummary }) {
  const [browsers, setBrowsers] = useState<PairedBrowser[]>([]);
  const [busy, setBusy] = useState(false);
  const connected = live.connected > 0;
  // read again when the link connects or pairs another browser
  useEffectOn([connected, live.browser], () => {
    if (!connected) {
      setBrowsers([]);
      return;
    }
    let on = true;
    native.availability.chromeBrowsers().then(
      (b) => on && setBrowsers(b),
      () => {
        /* no browser list: the status shows without it */
      },
    );
    return () => {
      on = false;
    };
  });
  const act = async (what: () => Promise<{ error: string | null; deferred?: boolean }[]>, failed: string) => {
    setBusy(true);
    try {
      const results = await what();
      const errors = results.filter((r) => r.error);
      if (errors.length) toast(`${failed}: ${errors[0].error}`, 'error');
      const waiting = results.filter((r) => r.deferred).length;
      // a chat mid-task keeps its browser until its turn ends
      if (waiting)
        toast(
          `${waiting === 1 ? 'A chat that is working switches' : `${waiting} chats that are working switch`} when the turn ends.`,
          'info',
        );
    } catch (e) {
      toast(`${failed}: ${errorText(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const current = browsers.find((b) => b.current)?.id ?? '';
  return (
    <>
      {live.down > 0 && (
        <button
          className="btn-pill soft"
          disabled={busy}
          onClick={() => act(() => native.availability.chromeReconnect(null), "Couldn't reconnect Claude in Chrome")}
        >
          {busy ? 'Reconnecting…' : 'Reconnect'}
        </button>
      )}
      {browsers.length > 1 && (
        <select
          className="text-input slim"
          aria-label="Select browser"
          value={current}
          disabled={busy}
          onChange={(e) => act(() => native.availability.chromeSelect(e.target.value), "Couldn't switch browsers")}
        >
          {!current && <option value="">Select browser</option>}
          {browsers.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
