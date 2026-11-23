// Settings → Connections → Phone: keep this Mac reachable with every window closed (menu-bar item, login item, sleep).
import { useEffect, useState } from 'react';
import { native } from '../../../lib/native';
import type { AlwaysOnPrefs, AlwaysOnState } from '../../../lib/native/alwaysOn';
import { ignoring } from '../../../lib/ignored';
import { toastFailure } from '../../../store/core';
import { Group, Row, Toggle } from './Controls';

export function MobileRemoteAlwaysOn() {
  const [state, setState] = useState<AlwaysOnState | null>(null);
  useEffect(() => {
    let live = true;
    void native.alwaysOn.get().then((s) => live && setState(s), ignoring('read the always-on settings'));
    const off = native.alwaysOn.onChanged((s) => live && setState(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  // only while Mobile Remote is on: no switch for a feature the user has not turned on
  if (!state?.remoteOn) return null;
  const move = (patch: Partial<AlwaysOnPrefs>, failed: string) => native.alwaysOn.set(patch).then(setState, toastFailure(failed));
  return (
    <Group title="Keep this Mac reachable">
      <Row
        title="Keep running in the menu bar"
        desc="Closing the last window keeps MoPilot running, so your phone can still reach it. Quit stops it."
      >
        <Toggle
          label="Keep running in the menu bar"
          on={state.prefs.keepRunning}
          onChange={(v) => move({ keepRunning: v }, "Couldn't change the menu bar setting")}
        />
      </Row>
      {state.loginItemSupported && (
        <Row title="Start at login" desc="Starts in the menu bar with no window. Needs the menu bar setting.">
          <Toggle
            label="Start at login"
            on={state.prefs.loginItem}
            disabled={!state.prefs.keepRunning}
            onChange={(v) => move({ loginItem: v }, "Couldn't change the login setting")}
          />
        </Row>
      )}
      <Row
        title="Stay awake when plugged in"
        desc="Keeps the Mac awake while it is plugged in with a phone paired. Closing the lid still sleeps it."
      >
        <Toggle
          label="Stay awake when plugged in"
          on={state.prefs.preventSleep}
          onChange={(v) => move({ preventSleep: v }, "Couldn't change the sleep setting")}
        />
      </Row>
    </Group>
  );
}
