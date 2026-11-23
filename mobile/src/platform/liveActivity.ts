// The app's Live Activity module (modules/mopilot-live-activity, iOS only) as the controller sees it; null where the module is not linked (Android, the web preview).
import type { LiveActivityNative, ActivityStateWire } from '../push/liveActivityController';

type Events = {
  addListener(name: 'onToken' | 'onEnded', listener: (event: { token?: string; dismissed?: boolean }) => void): { remove(): void };
};
type Raw = Events & {
  isEnabled(): Promise<boolean>;
  start(state: ActivityStateWire): Promise<boolean>;
  update(state: ActivityStateWire): Promise<void>;
  stripTitles(): Promise<void>;
  end(): Promise<void>;
  token(): Promise<string | null>;
  setTitlesSwitch(on: boolean): Promise<boolean>;
  loadPrefs(): Promise<string | null>;
  savePrefs(raw: string): Promise<void>;
};

/** Expo registers each linked native module on this global; there is none where the module is not built in (Android, the web preview). Reading it directly keeps `expo`'s global types out of the shared type check. */
const linked = (): Raw | null =>
  (globalThis as { expo?: { modules?: Record<string, Raw | undefined> } }).expo?.modules?.MoPilotLiveActivity ?? null;

export function liveActivityNative(raw: Raw | null = linked()): LiveActivityNative | null {
  if (!raw) return null;
  return {
    isEnabled: () => raw.isEnabled(),
    start: (state) => raw.start(state),
    update: (state) => raw.update(state),
    stripTitles: () => raw.stripTitles(),
    end: () => raw.end(),
    token: () => raw.token(),
    setTitlesSwitch: (on) => raw.setTitlesSwitch(on),
    loadPrefs: () => raw.loadPrefs(),
    savePrefs: (value) => raw.savePrefs(value),
    onToken(listener) {
      const sub = raw.addListener('onToken', (event) => {
        if (typeof event?.token === 'string' && event.token) listener(event.token);
      });
      return () => sub.remove();
    },
    onEnded(listener) {
      const sub = raw.addListener('onEnded', (event) => listener(event?.dismissed === true));
      return () => sub.remove();
    },
  };
}
