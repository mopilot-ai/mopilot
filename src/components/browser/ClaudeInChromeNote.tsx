// The one-time note for Claude in Chrome users on what reaches their Chrome now, on the Browser settings page and in a Claude chat.

import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import { ignoring } from '../../lib/ignored';
import { copy } from '../../harness/copy';
import { navigate } from '../../store/panes';
import { setPrefs, toastFailure, useStore } from '../../store/core';
import { Globe, X } from '../ui/icons';
import { chromeRouteOf, claudeRunsClaudeInChrome, useNativeAvailability } from '../../session/nativeAvailability';

/** The copy ends with its action in brackets; the action is the button. */
export function splitAction(t: string): [string, string] {
  const m = /\s*\[([^\]]+)\]\s*$/.exec(t);
  return m ? [t.slice(0, m.index), m[1]] : [t, 'Set up'];
}

/** The note's copy for what reaches the user's Chrome for Claude now (chromeRouteOf). */
const COPY_KEY = { own: 'claudeInChromeMigration', yourChrome: 'claudeInChromeYourChrome', none: 'claudeInChromeNoRoute' } as const;

/**
 * The one-time note for people who used Claude in Chrome: without it, what reaches their Chrome. Shown on
 * the Browser settings page and in the next Claude chat (`threadId`), until its action is taken or it is closed.
 * Where MoPilot's own extension serves Claude, its action opens the Browser settings, where that extension's
 * pairing shows, and changes no channel: Your Chrome would hide the chrome_* tools that serve the chat (#1631).
 * Only where nothing serves Claude does it offer Your Chrome, and it says so first.
 * While Claude Code sessions run Claude in Chrome themselves (native.claude.chrome on a subscription login
 * with the Claude extension installed: the shared status of electron/capabilities/nativeAvailability.cjs,
 * which asks electron/harness/claude/index.cjs nativeChromeFor) there is nothing to migrate: the note is hidden, not
 * dismissed, and comes back if that changes. Until that status is known, nothing is shown.
 */
export function ClaudeInChromeNote({ threadId }: { threadId?: string }) {
  const [show, setShow] = useState(false);
  const prefs = useStore((s) => s.prefs);
  const availability = useNativeAvailability();
  const nativeChrome = claudeRunsClaudeInChrome(availability);
  const known = availability !== null;
  useEffect(() => {
    if (!known || nativeChrome) return;
    let live = true;
    // unanswered: the note stays hidden, and the next chat asks again
    native.browser.claudeInChromeNote(threadId).then((v) => live && setShow(v), ignoring('ask whether to show the Claude in Chrome note'));
    return () => {
      live = false;
    };
  }, [threadId, known, nativeChrome]);
  if (nativeChrome || !show) return null;
  const route = chromeRouteOf(availability, prefs.browserChannel);
  const [note, action] = splitAction(copy('browser', COPY_KEY[route]));
  const done = () => {
    setShow(false);
    // hidden here either way; one main didn't record shows again in the next window
    native.browser.dismissClaudeInChromeNote().catch(ignoring('remember the Claude in Chrome note was dismissed'));
  };
  const setUp = async () => {
    if (route === 'none') {
      // the only route there is: the setting changes once main switched; a failed switch keeps the note
      try {
        await native.browser.configure({ channel: 'chrome', profileDir: prefs.chromeProfileDir });
      } catch (e) {
        return toastFailure("Couldn't switch to Your Chrome")(e);
      }
      setPrefs({ browserChannel: 'chrome' });
    }
    done();
    navigate({ name: 'settings', section: 'browser' });
  };
  return (
    <div className="elsewhere-notice claude-in-chrome-note" role="note">
      <span className="elsewhere-icon">
        <Globe size={14} />
      </span>
      <div className="elsewhere-text">
        <div className="elsewhere-title">{note}</div>
      </div>
      <div className="elsewhere-actions">
        <button className="btn-pill" onClick={setUp}>
          {action}
        </button>
        <button className="btn-pill ghost" aria-label="Dismiss" onClick={done}>
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
