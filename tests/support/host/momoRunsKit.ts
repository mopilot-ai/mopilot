import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import rrule from 'rrule';
// @ts-ignore: plain ESM without declarations
import { fakeGate } from './fakeGate.ts';
import { createMomoHome } from '../../../host/src/momoHome.mjs';
// @ts-ignore
import { createMomoChats } from '../../../host/src/momoChats.mjs';
// @ts-ignore
import { createMomoScheduler } from '../../../host/src/momoScheduler.mjs';
// @ts-ignore
import { momoRunsFor, createMomoHidden } from '../../../host/src/momoWiring.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../../../host/src/secretStore.mjs';
// @ts-ignore
import { createProtocol } from '../../../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../../../host/src/epochs.mjs';
// @ts-ignore
import { createGuard } from '../../../host/src/guard.mjs';
// @ts-ignore
import { createLedger } from '../../../host/src/ledger.mjs';
// @ts-ignore
import { scheduleRules } from '../../../shared/schedule.mjs';

export const MOMO = ['momo'];
export const PROVIDER_ENV = { ANTHROPIC_API_KEY: 'test-key', HOME: '/nonexistent-home', XDG_DATA_HOME: '/nonexistent-data' };
const quiet = { report: () => undefined };

/** A clock the test moves by hand; `after` timers fire when it is advanced past them. */
function manualClock(start = Date.now()) {
  let at = start;
  return { now: () => at, after: () => () => undefined, advance: (ms: number) => void (at += ms) };
}

/** A Host as the serve entry builds it, over a fake runtime that records what it is sent and a clock the test moves. */
export async function world(t: any, { harness = 'claude', signedIn = true, main: withMain = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-runs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = manualClock();
  const reports: string[] = [];
  const events: any = new EventEmitter();
  events.cancel = () => undefined;
  const sends: any[] = [];
  let failSend = false;
  let mainId = '';
  const runtime: any = {
    host: events,
    familyOf: (id: string) => (id.startsWith('claude:') ? 'claude' : 'acp'),
    send: async (p: any) => {
      if (failSend && p.key !== mainId) throw new Error('the harness refused it');
      sends.push(p);
      return { turnId: `t${sends.length}` };
    },
    permit: () => true,
    prepare: async () => undefined,
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const home = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(dir, 'config')),
    report: (m: string) => reports.push(m),
  });
  await home.grant({ account: 'a1', features: MOMO });
  await home.start({ name: 'Studio' });
  const records = new Map<string, any>();
  /** The Host's sessions state as a class that keeps its map in itself, so a method taken off it loses it (the real one does). */
  class States {
    #map = new Map<string, any>();
    has(id: string) {
      return this.#map.has(id);
    }
    get(id: string) {
      return this.#map.get(id);
    }
    set(id: string, value: any) {
      this.#map.set(id, value);
    }
  }
  const states = new States();
  const sessions: any = {
    chats: { records, patchMeta: (id: string, patch: object) => records.set(id, { meta: { ...records.get(id)?.meta, ...patch } }) },
    isolated: () => true,
  };
  home.gate = fakeGate();
  home.chats = createMomoChats({ home, sessions, epochs, env: PROVIDER_ENV });
  home.scheduler = createMomoScheduler({ home, rules: scheduleRules(rrule.RRule), clock, report: (m: string) => reports.push(m) });
  const main = withMain ? await (home.chats as any).start({ harness }) : { chatId: '' };
  mainId = main.chatId;
  /** What the approval engine tells its push port, and the timers it sets (fired by hand). */
  const pushes: any[] = [];
  const momoPushes: any[] = [];
  const hidden = createMomoHidden();
  hidden.bind((home.chats as any).isHidden);
  const timers: { fn: () => void; ms: number }[] = [];
  const protocol = createProtocol({
    runtime,
    epochs,
    guard,
    status: () => ({}),
    dataDir: dir,
    momo: home,
    notify: hidden.notify(
      (e: any) => void pushes.push(e),
      (e: any) => void momoPushes.push(e),
    ),
    approvalTimes: () => ({ remindMs: 600_000, pauseMs: 1_800_000 }),
    approvalClock: {
      now: clock.now,
      after: (fn: () => void, ms: number) => {
        const timer = { fn, ms };
        timers.push(timer);
        return () => void timers.splice(timers.indexOf(timer), 1);
      },
    },
  });
  const harnesses = async () => [{ id: harness.replace(/^acp:/, ''), detected: true, signedIn }];
  const runs = momoRunsFor(home, {
    protocol,
    events,
    state: states,
    harnesses,
    report: (m: string) => reports.push(m),
    now: clock.now,
  });
  const scheduler = home.scheduler as any as NonNullable<typeof home.scheduler>;
  const chats = home.chats as NonNullable<typeof home.chats>;
  const stores = () => home.stores() as NonNullable<ReturnType<typeof home.stores>>;
  const routine = async (extra: object = {}, approved = true) =>
    stores().routines.add({ name: 'Morning', prompt: 'Say what is new.', rrule: 'FREQ=HOURLY', sources: [], ...extra }, { approved });
  /** An hour passes, and the Host looks at what is due. */
  const minute = async () => {
    clock.advance(3_600_000);
    return scheduler.tick();
  };
  return {
    scheduler,
    chats,
    stores,
    dir,
    clock,
    reports,
    events,
    sends,
    home,
    main,
    protocol,
    runs,
    routine,
    minute,
    states,
    sessions,
    records,
    failSend: (v: boolean) => (failSend = v),
    pushes,
    momoPushes,
    timers,
  };
}

/** A turn of a chat, as the runtime tells it: only its start names the chat, the rest name the turn. */
export const turn = (w: any, chatId: string, text: string, stopReason = 'end_turn', turnId = `turn-${crypto.randomUUID()}`) => {
  w.events.emit('event', { kind: 'turnStart', key: chatId, turnId });
  w.events.emit('event', { kind: 'update', turnId, update: { sessionUpdate: 'agent_message_chunk', content: { text } } });
  w.events.emit('event', { kind: 'turnEnd', turnId, stopReason });
};
