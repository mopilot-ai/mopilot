// Settings › Haptic feedback: one switch kept on this phone; while it is off every haptic in motion.ts stays quiet.
let on = true;
/** Whether haptics play now: on until the saved choice says otherwise. */
export const hapticsOn = () => on;

export interface HapticsControl {
  read(): Promise<boolean>;
  /** Apply and keep the choice; rejects (and keeps the old one) when it could not be kept. */
  set(value: boolean): Promise<void>;
}

/** The control over a string store: anything but "off" is on, so an unreadable store never silences the phone. */
export function createHaptics(store: { read(): Promise<string | null>; write(value: string): Promise<void> }): HapticsControl {
  return {
    async read() {
      on = (await store.read().catch(() => null)) !== 'off';
      return on;
    },
    async set(value) {
      await store.write(value ? 'on' : 'off');
      on = value;
    },
  };
}
