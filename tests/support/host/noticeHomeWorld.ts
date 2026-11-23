// The world the real-service notice tests run in: `momoHomeFor` loads every service from host/src/momoServices/ (notice, learning, gate…), over a fake Google reader, a scripted reading model and a fake push.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoHidden, momoHomeFor } from '../../../host/src/momoWiring.mjs';
import { createMemoryVersionStore } from '../../../shared/momoNotice/memoryStore.ts';

const MOMO = ['momo'];
export const start = { homeId: 'home-aaaa-1111', name: 'Studio' };
const authPass = { 'Authentication-Results': 'mx.google.com; dkim=pass; dmarc=pass (p=NONE) header.from=acme.com' };

export const mailOf = (threadId: string, subject: string, body: string, over: object = {}) => ({
  id: `m-${threadId}`,
  threadId,
  from: 'Ana <ana@acme.com>',
  to: ['maya@x.com'],
  cc: [],
  subject,
  date: new Date().toISOString(),
  headers: authPass,
  labels: ['INBOX'],
  body,
  ...over,
});

export async function world(t: any, mode: string | undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-notice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') };
  const reports: string[] = [];
  const records = new Map<string, any>();
  const sessions: any = {
    chats: { records, patchMeta: (id: string, patch: object) => records.set(id, { meta: { ...records.get(id)?.meta, ...patch } }) },
    isolated: () => true,
    isolate: () => undefined,
  };
  const home: any = momoHomeFor({
    hostId: start.homeId,
    paths,
    report: (m: string) => reports.push(m),
    sessions,
    epochs: { current: () => 0 },
    hidden: createMomoHidden(),
    env: { ...(mode ? { MOMO_NOTICE_MODE: mode } : {}), MOMO_NOTICE_EVERY_MS: '0' },
  });
  t.after(() => home.close());
  await home.grant({ account: 'a1', features: MOMO });
  await home.start(start);
  // one UTC day, no quiet hours: what the test sees does not depend on the time it runs
  await home.prefs.change({ quietHours: null, brief: { on: true, zone: 'UTC', time: new Date().toISOString().slice(11, 16) } });

  const threads: Record<string, any> = {};
  const calls = { listThreads: 0, getMail: 0 };
  const versions = createMemoryVersionStore();
  const client = {
    listThreads: async () => (calls.listThreads++, { threadIds: Object.keys(threads) }),
    getThreadMeta: async (id: string) => ({ id, messages: [{ id: threads[id].id, internalDate: String(Date.parse(threads[id].date)) }] }),
    getMail: async (id: string) => (calls.getMail++, threads[id] ?? null),
    listEvents: async () => ({ events: [] }),
    calendarEtag: async () => 'etag-1',
  };
  home.provide('google', {
    reader: async () => ({ client, versions }),
    status: async () => ({ kind: 'connected_read_only', email: 'maya@x.com', connectedAt: 1 }),
  });
  const told: any[] = [];
  home.push = { tell: async (item: any) => (told.push(item), { status: 'sent' }) };
  const prompts: string[] = [];
  const answers: string[] = [];
  home.service('notice').setModel({
    name: 'fake',
    complete: async (prompt: string) => (prompts.push(prompt), answers.shift() ?? 'no answer'),
  });
  const answer = (verdict: string, reason = 'It needs you.') => JSON.stringify({ verdict, reason, matterKey: 'gmail:x' });
  return { dir, home, reports, threads, calls, told, prompts, answers, answer, notice: () => home.service('notice') };
}
