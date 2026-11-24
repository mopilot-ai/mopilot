// Settings → Connections → Phone: keep this Mac reachable with every window closed (menu-bar item, login item, sleep).
import { type ReactNode, useEffect, useState } from 'react';
import { native } from '../../../lib/native';
import type { AlwaysOnPrefs, AlwaysOnState } from '../../../lib/native/alwaysOn';
import { ignoring } from '../../../lib/ignored';
import { toastFailure } from '../../../store/core';
import { Group, Row, Toggle } from './Controls';

/** Other settings of Control this Mac: stay awake, the menu bar and login item (while connections are allowed), and `extra` rows of other kinds of control (Codex's). */
export function MobileRemoteAlwaysOn({ extra = null, extraVisible = false }: { extra?: ReactNode; extraVisible?: boolean } = {}) {
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
  const awake = state?.remoteOn === true;
  if (!awake && !extraVisible) return null;
  const move = (patch: Partial<AlwaysOnPrefs>, failed: string) => native.alwaysOn.set(patch).then(setState, toastFailure(failed));
  return (
    <Group title="Other settings">
      {state && awake && (
        <>
          <Row
            title="Keep this Mac awake"
            desc="Prevent sleep while this Mac is plugged in with a phone paired and connections allowed. Closing the lid still sleeps it."
          >
            <Toggle
              label="Keep this Mac awake"
              on={state.prefs.preventSleep}
              onChange={(v) => move({ preventSleep: v }, "Couldn't change the sleep setting")}
            />
          </Row>
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
        </>
      )}
      {extra}
    </Group>
  );
}
