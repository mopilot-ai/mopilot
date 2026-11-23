// The browser channel state a BrowserPanel follows (Your Chrome or the built-in browser, and its token), read once and then as main changes it.
import { useEffect, useState } from 'react';
import { native, type ChromeState } from '../../../lib/native';
import { noteIgnored } from '../../../lib/ignored';

export function useChromeState() {
  const [chrome, setChrome] = useState<ChromeState | null>(null);
  useEffect(() => {
    let live = true;
    native.browser
      .chromeState()
      .then((s) => live && setChrome(s))
      // keep the default; onChannelChanged updates it
      .catch((e) => noteIgnored("read the browser pane's Chrome state", e));
    const off = native.browser.onChannelChanged(setChrome);
    return () => {
      live = false;
      off();
    };
  }, []);
  return chrome;
}
