// Settings → Browser: links, downloads, the browser channel (built-in or Your Chrome) and its storage.

import { Group, Row, Toggle, Select } from './Controls';
import { useEffect, useState } from 'react';
import { CHROME_APPROVAL } from '../../../../shared/browser.mjs';
import { useStore, setPrefs, toast, toastFailure } from '../../../store/core';
import { native, type ChromeState } from '../../../lib/native';
import { ignoring } from '../../../lib/ignored';
import { openLink } from '../../../session/open';
import { ClaudeInChromeNote } from '../../browser/ClaudeInChromeNote';
import { NativeControlStatus } from './NativeControlStatus';
import { BrowserUseSettings } from './BrowserUse';
import { BrowserStorageRow } from './BrowserStorage';
import { BrowserImportData } from './BrowserImportData';
import { BrowserRoutines } from './BrowserRoutines';
import { isEnabled } from '../../../lib/flags';
import { openImportDialog } from '../../../lib/browserImport';
import { shortPath } from './Rows';
import { useNativeAvailability } from '../../../session/nativeAvailability';

/* ------------------------------------------------------------------ */
/* Browser                                                             */
/* ------------------------------------------------------------------ */
export function BrowserSettings() {
  const prefs = useStore((s) => s.prefs);
  return (
    <>
      <p className="settings-sub settings-lead">The browser agents use, and the built-in browser's data.</p>
      <ClaudeInChromeNote />
      <NativeControlStatus surface="chrome" />
      <BrowserChannel />
      <BrowserRoutines />
      <Group title="General">
        <Row title="Open local sites in">
          <Select
            value={prefs.localUrlDestination}
            options={[
              { value: 'in-app', label: 'MoPilot' },
              { value: 'default', label: 'Default browser' },
            ]}
            onChange={(v) => setPrefs({ localUrlDestination: v })}
          />
        </Row>
        <Row title="Show full URL" desc="Include the path, query, and fragment in the address bar">
          <Toggle on={prefs.browserFullUrl} onChange={(v) => setPrefs({ browserFullUrl: v })} />
        </Row>
        {isEnabled('shared.browser.turnTrace') && (
          <Row title="Record turn replays" desc="Save each turn's browser steps to replay later">
            <Toggle on={prefs.browserTurnTrace} onChange={(v) => setPrefs({ browserTurnTrace: v })} />
          </Row>
        )}
      </Group>
      <BrowserUseSettings />
      <Group title="Browsing data">
        <BrowserStorageRow />
        <Row
          title="Browsing data"
          desc={`Clear history, cookies and cache${isEnabled('shared.browser.import') ? ', or import from another browser' : ''}.`}
        >
          {isEnabled('shared.browser.import') && (
            <button className="btn-pill soft" onClick={() => openImportDialog()}>
              Import…
            </button>
          )}
          <button
            className="btn-pill soft"
            onClick={async () => {
              if (!confirm('Clear all browsing data from the built-in browser?')) return;
              // main reports a clear that failed part way, so the data may still be there
              await native.browser.clearData().then(() => toast('Browsing data cleared'), toastFailure("Couldn't clear browsing data"));
            }}
          >
            Clear browsing data
          </button>
        </Row>
        <BrowserImportData />
      </Group>
      <Group title="Downloads">
        <Row title="Location" desc={prefs.downloadsDir ? shortPath(prefs.downloadsDir, 40) : 'System Downloads folder'}>
          <button
            className="btn-pill soft"
            onClick={async () => {
              const p = await native.dialog.openFolder();
              // the setting changes once main uses it
              if (p)
                native.browser
                  .setDownloads(p, prefs.askWhereToSave)
                  .then(() => setPrefs({ downloadsDir: p }), toastFailure("Couldn't change where downloads go"));
            }}
          >
            Change
          </button>
          {prefs.downloadsDir && (
            <button
              className="btn-pill soft"
              onClick={() =>
                native.browser
                  .setDownloads(null, prefs.askWhereToSave)
                  .then(() => setPrefs({ downloadsDir: null }), toastFailure("Couldn't change where downloads go"))
              }
            >
              Reset
            </button>
          )}
        </Row>
        <Row title="Ask where to save downloads" desc="Show a save dialog for downloads you start in the built-in browser">
          <Toggle
            on={prefs.askWhereToSave}
            onChange={(v) =>
              native.browser
                .setDownloads(prefs.downloadsDir, v)
                .then(() => setPrefs({ askWhereToSave: v }), toastFailure("Couldn't change where downloads go"))
            }
          />
        </Row>
      </Group>
    </>
  );
}

/** Claude Desktop's "Preferred browser" choices, in MoPilot's names for them. */
const CHANNELS: { value: 'builtin' | 'chrome'; label: string }[] = [
  { value: 'builtin', label: 'Built-in browser' },
  { value: 'chrome', label: 'Chrome' },
];

/** A new profile or token reaches a chat working in Chrome only after its turn: say so, rather than stop its task. */
function shown(s: ChromeState): ChromeState {
  const n = s.waitingChats ?? 0;
  if (n)
    toast(`${n === 1 ? 'A chat in Chrome switches' : `${n} chats in Chrome switch`} when ${n === 1 ? 'its' : 'their'} turn ends.`, 'info');
  return s;
}

/**
 * Which browser agents prefer: the built-in one, or the user's Chrome. Where MoPilot's own extension serves Chrome
 * (`own`), Chrome is reached through it for every harness and the Playwright Extension's rows are gone (design D5,
 * "Retiring step 1"); a build without it keeps them. Claude Code may use Claude in Chrome instead, by choice.
 */
function BrowserChannel() {
  const prefs = useStore((s) => s.prefs);
  const [state, setChrome] = useState<ChromeState | null>(null);
  const [token, setToken] = useState('');
  const [profile, setProfile] = useState(prefs.chromeProfileDir);
  const [test, setTest] = useState<{ ok: boolean; message: string } | 'running' | null>(null);
  // MoPilot's own extension serves the user's Chrome to agents unless Your Chrome takes its place (#1631)
  const own = !!useNativeAvailability()?.chromeTools;
  useEffect(() => {
    // optional: without it the page leaves out what it would say about Your Chrome, and the next visit asks again
    native.browser.chromeState().then(setChrome, ignoring('read the Your Chrome state for Settings'));
  }, []);
  const apply = async (patch: Partial<{ browserChannel: 'builtin' | 'chrome'; chromeProfileDir: string }>) => {
    setTest(null);
    const next = { ...prefs, ...patch };
    // the setting changes once main has switched to it
    try {
      const s = await native.browser.configure({ channel: next.browserChannel, profileDir: next.chromeProfileDir });
      // only a new profile restarts the chats' connections
      setChrome('chromeProfileDir' in patch ? shown(s) : s);
    } catch (e) {
      return toastFailure("Couldn't switch the agents' browser")(e);
    }
    setPrefs(patch);
  };
  const chrome = prefs.browserChannel === 'chrome';
  return (
    <>
      <Group title="Browser for agents">
        {/* one row, as Claude Desktop's Settings → General → Preferred browser; the built-in browser starts with none of
            your sign-ins, Chrome uses them */}
        <Row
          title="Preferred browser"
          desc={
            !own && state && chrome && state.active !== 'chrome'
              ? "Chrome isn't available. Test the connection below."
              : chrome
                ? 'Agents use your Chrome unless you ask otherwise.'
                : 'Agents use the built-in browser unless you ask otherwise.'
          }
        >
          <Select
            value={prefs.browserChannel}
            options={CHANNELS}
            width={220}
            onChange={(v) => v !== prefs.browserChannel && apply({ browserChannel: v })}
          />
        </Row>
      </Group>
      {own && (
        <Group title="Claude Code">
          <Row title="Use Claude in Chrome" desc="Instead of the MoPilot extension. Needs a claude.ai subscription.">
            <Toggle
              on={prefs.claudeInChrome}
              onChange={(v) =>
                // main saves it (each Claude Code session start reads it), then the rows above are read again
                native.browser.claudeInChrome(v).then((saved) => {
                  setPrefs({ claudeInChrome: saved });
                  native.availability.status(true).catch(ignoring('read the browser rows again'));
                }, toastFailure("Couldn't change the setting"))
              }
            />
          </Row>
        </Group>
      )}
      {chrome && !own && (
        <Group title="Your Chrome">
          <Row title="Playwright Extension" desc="Install it in Chrome, then test the connection.">
            <button className="btn-pill soft" onClick={() => state && openLink(state.extensionUrl)}>
              Get the extension
            </button>
          </Row>
          <Row
            title="Connection token"
            desc={
              state?.hasToken
                ? 'Saved in your keychain. Chrome connects without asking.'
                : 'Optional. Stops Chrome asking on each connection.'
            }
          >
            <input
              className="text-input slim"
              type="password"
              placeholder="Token"
              aria-label="Connection token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button
              className="btn-pill soft"
              disabled={!token.trim() && !state?.hasToken}
              onClick={async () => {
                // no keychain (false), or one that refused (a throw): the token stays in the field
                const ok = await native.browser.setChromeToken(token).catch((e) => {
                  toastFailure("Couldn't save the token in the keychain")(e);
                  return null;
                });
                if (ok === null) return;
                if (!ok) toast("Couldn't save the token in the keychain", 'error');
                setToken('');
                setChrome(shown(await native.browser.chromeState()));
              }}
            >
              {token.trim() || !state?.hasToken ? 'Save' : 'Remove'}
            </button>
          </Row>
          <Row title="Chrome profile" desc="Such as Profile 1. Leave empty for the last one you used.">
            <input
              className="text-input slim"
              placeholder="Default"
              aria-label="Chrome profile"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              onBlur={() => profile.trim() !== prefs.chromeProfileDir && apply({ chromeProfileDir: profile.trim() })}
            />
          </Row>
          <Row
            title="Connection"
            desc={
              test === 'running'
                ? state?.hasToken
                  ? 'Connecting to Chrome…'
                  : `Connecting to Chrome… ${CHROME_APPROVAL}`
                : test
                  ? test.message
                  : 'Opens a tab group in Chrome and closes it again.'
            }
          >
            <button
              className="btn-pill soft"
              disabled={test === 'running'}
              onClick={async () => {
                setTest('running');
                setTest(await native.browser.testChrome());
              }}
            >
              Test connection
            </button>
          </Row>
        </Group>
      )}
    </>
  );
}
