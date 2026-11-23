// MoMo's settings on a Host (M1 H3b, designs/momo-m1-home): what its routines read (how often it reaches out, quiet hours, paused), sealed beside the home and set by a client that may see MoMo; the shape is the app's own `prefs.momo` (shared/momoRoutine.mjs routineSettings), so the same service reads either.
import path from 'node:path';
import { createRequire } from 'node:module';
import { PROACTIVITY } from '../../shared/momoRoutine.mjs';
import { HostRefusal } from './hostFs.mjs';
import { dailySettingsOf } from './momoDaily.mjs';
import { clockMinutes, minuteInQuiet } from './momoClock.mjs';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../electron/gateway/sealedFile.cjs');

/** @param {any} v */
const prefsShape = (v) => ({
  routines: v?.routines && typeof v.routines === 'object' && !Array.isArray(v.routines) ? v.routines : {},
  paused: v?.paused === true,
  // the morning brief (S6): off until the owner turns it on; time "HH:MM" on `zone`
  brief: {
    on: v?.brief?.on === true,
    time: typeof v?.brief?.time === 'string' ? v.brief.time : undefined,
    zone: typeof v?.brief?.zone === 'string' ? v.brief.zone : undefined,
  },
  // push (S7): lock-screen text is off until the owner turns it on; at most this many tell-now pushes a day
  notify: {
    previews: v?.notify?.previews === true,
    tellNowMax:
      Number.isInteger(v?.notify?.tellNowMax) && v.notify.tellNowMax >= 1 && v.notify.tellNowMax <= 50
        ? v.notify.tellNowMax
        : DEFAULT_TELL_NOW_MAX,
  },
});
/** Tell-now pushes a day unless the owner says otherwise (design D2). */
export const DEFAULT_TELL_NOW_MAX = 6;

/**
 * @param {object} o
 * @param {{ data: { safeStorage: any }, storage: { dir: string } }} o.home
 * @param {() => number} [o.now]
 */
export function createMomoPrefs({ home, now = Date.now }) {
  const file = new SealedJson({
    file: path.join(home.storage.dir, 'prefs.json'),
    safeStorage: home.data.safeStorage,
    shape: prefsShape,
    now,
  });
  /** What the file holds, or the defaults when it cannot be read (the next call tries again). */
  const read = () => {
    try {
      return file.read();
    } catch {
      // settings that cannot be read are not the defaults: MoMo does nothing on its own until they can
      return {
        routines: { proactivity: 'off' },
        paused: true,
        brief: { on: false, time: undefined, zone: undefined },
        notify: { previews: false, tellNowMax: DEFAULT_TELL_NOW_MAX },
      };
    }
  };
  /** What a client is told: how often, quiet hours (absent: the default), paused. */
  const get = () => {
    const p = read();
    return {
      proactivity: PROACTIVITY.includes(p.routines.proactivity) ? p.routines.proactivity : 'default',
      quietHours: p.routines.quietHours,
      paused: p.paused,
      brief: { ...p.brief },
      notify: { ...p.notify },
    };
  };
  return {
    get,
    /** The prefs as the routines service reads them. */
    forRoutines() {
      const p = read();
      return { momo: { routines: p.routines, paused: p.paused, brief: p.brief, notify: p.notify } };
    },
    /** Change what is named. @param {{ proactivity?: string, quietHours?: { start: string, end: string } | null, paused?: boolean, brief?: { on?: boolean, time?: string, zone?: string }, notify?: { previews?: boolean, tellNowMax?: number } }} patch */
    async change(patch) {
      await file.change((p) => {
        if (patch.proactivity !== undefined) p.routines.proactivity = patch.proactivity;
        if (patch.quietHours !== undefined) p.routines.quietHours = patch.quietHours;
        if (patch.paused !== undefined) p.paused = patch.paused;
        if (patch.brief) Object.assign(p.brief, patch.brief);
        if (patch.notify) Object.assign(p.notify, patch.notify);
        // a brief time inside quiet hours would never fire and say nothing: the setting is refused with the cause
        const day = dailySettingsOf({ momo: { brief: p.brief, routines: p.routines } });
        if (p.brief.on && minuteInQuiet(day.quiet, /** @type {number} */ (clockMinutes(day.time))))
          throw new HostRefusal(
            'momo_brief_in_quiet',
            'The brief time is inside quiet hours, so it would never be sent. Pick a time when quiet hours are over, or change them.',
          );
      });
      return get();
    },
  };
}
