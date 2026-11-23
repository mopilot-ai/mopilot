// The world the notice collector tests run in: a fake home with a sealed store, a fake Google reader, a scripted reading model and a clock the test moves.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoNotice } from '../../../host/src/momoNotice.mjs';
// @ts-ignore
import { createNoticeStore } from '../../../host/src/momoNoticeStore.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../../../host/src/secretStore.mjs';
import { createMemoryVersionStore } from '../../../shared/momoNotice/memoryStore.ts';

export const NOON = Date.parse('2026-11-24T12:00:00Z');
export const answer = (verdict: string, reason = 'It needs you.') => JSON.stringify({ verdict, reason, matterKey: 'gmail:x' });
export const mail = (threadId: string, over: object = {}) => ({
  id: `m-${threadId}`,
  threadId,
  from: 'Ana <ana@acme.com>',
  to: ['maya@x.com'],
  cc: [],
  subject: `Subject ${threadId}`,
  date: '2026-11-24T11:00:00Z',
  headers: { 'Authentication-Results': 'mx.google.com; dmarc=pass header.from=acme.com' },
  labels: ['INBOX'],
  body: 'Please confirm today.',
  ...over,
});

export function rig(
  t: any,
  o: {
    mode?: 'off' | 'brief' | 'tell_now';
    push?: boolean | 'none';
    status?: any;
    model?: boolean | ((prompt: string) => Promise<string>);
    readsPerDay?: number;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-collector-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { at: NOON };
  const reports: string[] = [];
  const rows: any[] = [];
  const state: any = { stamp: { homeId: 'h', leaseEpoch: 1 }, current: true, receive: true, paused: false };
  const home: any = {
    stamp: () => state.stamp,
    current: () => state.current,
    receiveStamp: async () => ({ ok: state.receive }),
    prefs: {
      get: () => ({ paused: state.paused }),
      forRoutines: () => ({ momo: { routines: {}, paused: state.paused, brief: { on: true, zone: 'UTC' }, notify: { tellNowMax: 6 } } }),
    },
    rows: { put: async (row: any) => void rows.push(row) },
    service: (name: string) => (name === 'learning' ? state.learning : undefined),
    storage: { dir, safeStorage: createFileSafeStorage(dir) },
    data: { safeStorage: createFileSafeStorage(dir) },
  };
  const store = createNoticeStore({ home, now: () => clock.at });
  const world: any = {
    threads: {} as Record<string, any>,
    events: [] as any[],
    fail: {} as Record<string, boolean>,
    hide: new Set<string>(),
    etag: 'e1',
  };
  const versions = createMemoryVersionStore();
  const client = {
    listThreads: async () => {
      if (world.fail.gmail) throw new Error('Gmail is down');
      return { threadIds: Object.keys(world.threads) };
    },
    getThreadMeta: async (id: string) => ({
      id,
      messages: [
        { id: world.threads[id].id, internalDate: String(Date.parse(world.threads[id].date)), labelIds: world.threads[id].labels },
      ],
    }),
    getMail: async (id: string) => (world.hide.has(id) ? null : (world.threads[id] ?? null)),
    listEvents: async () => {
      if (world.fail.calendar) throw new Error('Calendar is down');
      return { events: world.events };
    },
    calendarEtag: async () => {
      if (world.fail.calendar) throw new Error('Calendar is down');
      return world.etag;
    },
  };
  const told: any[] = [];
  const pushResult = { status: 'sent' };
  const push =
    o.push === 'none'
      ? undefined
      : o.push === false
        ? undefined
        : { tell: async (item: any) => (told.push(item), await state.onTell?.(item), { ...pushResult }) };
  const answers: string[] = [];
  const prompts: string[] = [];
  const model =
    o.model === false
      ? null
      : {
          name: 'fake',
          complete: async (prompt: string) => (
            prompts.push(prompt), typeof o.model === 'function' ? o.model(prompt) : (answers.shift() ?? 'no answer')
          ),
        };
  const notice = createMomoNotice({
    home,
    store,
    reader: async () => {
      if (world.fail.reader) throw new Error('Google is not connected');
      return { client, versions };
    },
    google: async () => o.status ?? { kind: 'connected_read_only', email: 'maya@x.com' },
    model: () => model,
    mode: () => o.mode ?? 'tell_now',
    push: () => push,
    machine: () => ({ machineId: 'm1', name: 'Studio' }),
    now: () => clock.at,
    report: (m: string) => reports.push(m),
    everyMs: 5 * 60_000,
    ...(o.readsPerDay ? { readsPerDay: o.readsPerDay } : {}),
  });
  return { notice, store, home, state, world, clock, reports, told, rows, answers, prompts, pushResult, versions, client };
}
export const minutes = (n: number) => n * 60_000;
