// The pane's first-run offer to bring bookmarks, history and sign-ins from the user's other browsers: shown while the offer is pending and not put off, never in an agent's tab; closing it ("Not now") returns it after 1, 3 then 7 days.
import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import { isEnabled } from '../../lib/flags';
import { noteIgnored } from '../../lib/ignored';
import { offerDue, offerSources, openImportDialog, snoozed } from '../../lib/browserImport';
import { setPrefs, useStore } from '../../store/core';
import { PaneNotice } from './browserPanel/PaneNotice';

/** "Chrome", "Chrome and Safari", "Chrome, Arc and Safari". */
export function joinNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function BrowserImportCard() {
  const prompt = useStore((s) => s.prefs.browserImportPrompt);
  const until = useStore((s) => s.prefs.browserImportSnoozeUntil);
  const snoozes = useStore((s) => s.prefs.browserImportSnoozes);
  const [names, setNames] = useState<string[]>([]);
  const due = isEnabled('shared.browser.import') && offerDue({ browserImportPrompt: prompt, browserImportSnoozeUntil: until }, Date.now());
  useEffect(() => {
    if (!due) return setNames([]);
    let live = true;
    native.browser.import
      .sources()
      .then((list) => live && setNames(offerSources(list).map((s) => s.name)))
      .catch((e) => noteIgnored('look for browsers to import from', e));
    return () => {
      live = false;
    };
  }, [due]);
  if (!due || !names.length) return null;
  return (
    <PaneNotice
      className="browser-import-card"
      role="region"
      label="Import browser data"
      closeLabel="Not now"
      onClose={() => setPrefs(snoozed(snoozes, Date.now()))}
    >
      <span>Bring your bookmarks, history and sign-ins from {joinNames(names)}.</span>
      <div className="browser-notice-actions">
        <button className="primary" onClick={() => openImportDialog()}>
          Import…
        </button>
        <button onClick={() => setPrefs({ browserImportPrompt: 'dismissed' })}>Don&apos;t show again</button>
      </div>
    </PaneNotice>
  );
}
