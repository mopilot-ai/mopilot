// What the serve entry plugs into the protocol for approvals: the push notifier on the relay links, gated by the owner's notification settings, and the approval timings from the owner's policy.
import os from 'node:os';
import { createPushNotifier } from './pushNotifier.mjs';
import { createRelayLinks } from './relayLink.mjs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createMomoPush, pushShape } from './momoPush.mjs';
import { dailySettingsOf } from './momoDaily.mjs';
import { createStampSeal } from '../../shared/remote/stampSeal.mjs';
import { createNodePrimitives } from '../../shared/remote/nodePrimitives.mjs';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../electron/gateway/sealedFile.cjs');

const MINUTE = 60_000;
const minutesOf = (/** @type {string} */ hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * When quiet hours end, if `now` is inside them (`start` to `end` on the clock of `tz`, the window may cross midnight), else null.
 * @param {{ start: string, end: string, tz: string } | null | undefined} quiet @param {number} now
 */
export function quietEnd(quiet, now) {
  if (!quiet) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: quiet.tz,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return null;
  }
  const get = (/** @type {string} */ type) => Number(parts.find((p) => p.type === type)?.value);
  const at = get('hour') * 60 + get('minute');
  const [start, end] = [minutesOf(quiet.start), minutesOf(quiet.end)];
  if (start === end) return null;
  const inside = start < end ? at >= start && at < end : at >= start || at < end;
  if (!inside) return null;
  const left = (end - at + 1440) % 1440;
  return now + left * MINUTE - get('second') * 1000;
}

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./policy.mjs').createPolicy>} o.policy the owner's rules: notification settings and approval timings
 * @param {{ pushTargets: () => any[], push: (hostId: string, req: any) => Promise<string> }} o.relay the enrolled links; only phone enrollments are targets
 * @param {() => string} o.machineName
 * @param {() => number} [o.now]
 * @param {(message: string) => void} [o.report]
 * @param {Partial<Parameters<typeof createPushNotifier>[0]>} [o.notifier] timers and primitives a test drives
 */
export function pushWiringFor({ policy, relay, machineName, now = Date.now, report, notifier = {} }) {
  const settings = () => policy.approvalSettings();
  /** @type {WeakMap<object, ReturnType<typeof createMomoPush>>} */
  const momoPushes = new WeakMap();
  const stamps = createStampSeal(createNodePrimitives());
  const push = createPushNotifier({
    targets: () => relay.pushTargets(),
    send: (hostId, req) => relay.push(hostId, req),
    machineName,
    detail: () => settings().notify.detail,
    quietUntil: () => quietEnd(settings().notify.quiet, now()),
    now,
    report,
    ...notifier,
  });
  const wiring = {
    /** The engine's push port: the owner's choices decide which kinds are sent; a clearing follows only a push that was sent, so it is never gated. @param {{ kind: string, chatId: string, card?: any }} event */
    notify(event) {
      const { needsYou, paused } = settings().notify;
      if ((event.kind === 'needsYou' || event.kind === 'reminder') && !needsYou) return undefined;
      if (event.kind === 'paused' && !paused) return undefined;
      return push.notify(/** @type {any} */ (event));
    },
    /**
     * MoMo's own push (./momoPush.mjs) over the same links, on MoMo's own quiet hours, made once per home: the day's count and the pushes sent are sealed beside the home's data, a push goes only while this Host is the running home, and lock-screen text is sealed only if `sealBody` can.
     * @param {{ granted: () => boolean, stamp: () => any, current: (s: unknown) => boolean, receiveStamp: (s: unknown) => { ok: boolean } | Promise<{ ok: boolean }>, data: { safeStorage: any }, storage: { dir: string }, prefs: { forRoutines: () => any } }} home
     * @param {{ sealBody?: Parameters<typeof createMomoPush>[0]['sealBody'] }} [parts]
     */
    momoPush(home, parts = {}) {
      let made = momoPushes.get(home);
      if (made) return made;
      const file = new SealedJson({
        file: path.join(home.storage.dir, 'push.json'),
        safeStorage: home.data.safeStorage,
        shape: pushShape,
        now,
      });
      made = createMomoPush({
        // a Host whose grant lapsed pushes nothing, nor one that is not the running home (the stamp below)
        allowed: () => home.granted(),
        targets: () => relay.pushTargets(),
        send: (hostId, req) => relay.push(hostId, req),
        store: { read: () => file.read(), change: (fn) => file.change(fn) },
        settings: () => {
          const prefs = home.prefs.forRoutines();
          const day = dailySettingsOf(prefs);
          return {
            previews: prefs.momo.notify.previews,
            tellNowMax: prefs.momo.notify.tellNowMax,
            zone: /** @type {string} */ (day.zone),
            quiet: day.quiet ?? null,
          };
        },
        sealBody: parts.sealBody,
        // the lease, sealed under the enrollment's pair root: only that phone can read it
        sealStamp: (t, ref, stamp) => (t.root ? stamps.seal({ key: stamps.stampKey(t.root), ref, ...stamp }) : null),
        stamp: () => home.stamp(),
        current: (s) => home.current(s),
        receive: (s) => home.receiveStamp(s),
        report,
        now,
      });
      momoPushes.set(home, made);
      return made;
    },
    /** The approval engine's push port for a MoMo chat's card. @param {Parameters<typeof wiring.momoPush>[0]} home */
    momoNotify: (home) => wiring.momoPush(home).notify,
    /** For `host.status`: the phones linked to push to, and the cards that found none (#4721). */
    state: () => ({ phones: relay.pushTargets().length, ...push.state() }),
    /** When a waiting card reminds and pauses the run: the owner's minutes (ten and thirty until they say). */
    approvalTimes() {
      const a = settings().approvals;
      return { remindMs: a.remindMinutes * MINUTE, pauseMs: a.pauseMinutes * MINUTE };
    },
    close: () => push.close(),
  };
  return { ...wiring, options: { notify: wiring.notify, approvalTimes: wiring.approvalTimes } };
}

/** The relay path (each enrolled app's link pipes its streams into this Host's own socket, so it starts once the socket is up) and the approval push on its links. @param {{ configDir: string, socketPath: string, policy: any, report?: (m: string) => void }} o */
export function relayWithPush({ configDir, socketPath, policy, report }) {
  const relayLinks = createRelayLinks({ configDir, socketPath, report });
  return { relayLinks, approvalPush: pushWiringFor({ policy, relay: relayLinks, machineName: os.hostname, report }) };
}

// pairing by code is built beside the relay links it enrols on (./codePairWiring.mjs)
export { codePairFor } from './codePairWiring.mjs';
