// The world of the notes tool tests: a Host's registry with MoMo's home active, one MoMo chat, and the gate, learning, notes and owner-words services behind the registry's chokepoint; and the owner's message through the Host's own guard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../../../host/src/momoHome.mjs';
// @ts-ignore
import { createMomoChats } from '../../../host/src/momoChats.mjs';
// @ts-ignore
import { registerMomoTools } from '../../../host/src/momoTools.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../../../host/src/secretStore.mjs';
// @ts-ignore
import { createEpochStore } from '../../../host/src/epochs.mjs';
// @ts-ignore
import gateService from '../../../host/src/momoServices/gate.mjs';
// @ts-ignore
import learningService from '../../../host/src/momoServices/learning.mjs';
// @ts-ignore
import notesService from '../../../host/src/momoServices/notes.mjs';
// @ts-ignore
import questionsService from '../../../host/src/momoServices/questions.mjs';
// @ts-ignore
import ownerWordsService from '../../../host/src/momoServices/ownerWords.mjs';

const require = createRequire(import.meta.url);
const { Registry } = require('../../../electron/capabilities/contract/registry.cjs');
const { segmentKey } = require('../../../electron/platform/segmentOwner.cjs');

export const MOMO = ['momo'];
const ENV = { ANTHROPIC_API_KEY: 'test-key', HOME: '/nonexistent-home', XDG_DATA_HOME: '/nonexistent-data' };

/** A Host's registry with MoMo's home active and one MoMo chat, the gate service behind the registry's chokepoint. */
export async function world(
  t: any,
  { grant = true, start = true, report }: { grant?: boolean; start?: boolean; report?: (m: string) => void } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = new Registry();
  const ran: string[] = [];
  for (const name of ['browser_open', 'shell_run'])
    registry.register({
      name,
      policy: 'observe',
      description: name,
      schema: { type: 'object', properties: {} },
      handler: () => (ran.push(name), 'done'),
    });
  const records = new Map<string, any>();
  const patchMeta = (id: string, patch: object) => {
    const rec = records.get(id) ?? {
      id,
      segments: [{ kind: 'claude', nativeId: id.replace(/^claude:/, ''), start: 0, count: null }],
      meta: {},
    };
    records.set(id, { ...rec, meta: { ...rec.meta, ...patch } });
  };
  const sessions: any = { chats: { records, patchMeta }, isolated: () => true };
  const home: any = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(dir, 'config')),
    isMomoChat: (id: string) => !!home.chats?.isMomoChat(id),
  });
  if (grant) await home.grant({ account: 'a1', features: MOMO });
  const epochs = createEpochStore(path.join(dir, 'e.json'), { report: () => undefined });
  home.chats = createMomoChats({ home, sessions, epochs, env: ENV });
  if (start) await home.start({ name: 'Studio' });
  t.after(() => home.lifecycle('pause'));
  const { chatId: M } = await home.chats.start({ harness: 'claude' });
  const coding = `claude:${crypto.randomUUID()}`;
  patchMeta(coding, {});
  const clock = { at: Date.now() };
  const now = () => clock.at;
  gateService({ home, now, report });
  learningService({ home, now });
  notesService({ home, now });
  ownerWordsService({ home, now });
  questionsService({ home, now, report });
  const off = registerMomoTools({ registry, home, sessions });
  const segment = (id: string) => segmentKey('claude', id.replace(/^claude:/, ''));
  const call = (chatId: string, tool: string, args: object = {}) => registry.invoke(chatId, segment(chatId), tool, args);
  const names = (chatId: string) =>
    registry
      .list({ chatId })
      .map((x: any) => x.name)
      .sort();
  return { clock, dir, registry, home, M, coding, ran, call, names, off, records, sessionsOf: sessions, epochs };
}

/** What a call said: its text when it ran, or the refusal's code. */
export const said = (r: any) => (r.ok ? r.content.map((c: any) => c.text).join('\n') : `refused:${r.error.code}`);
export const phone = { kind: 'phone', fingerprint: 'phone-a' };
let n = 0;
/** The owner sends a message to the main chat through the Host's own guard, as the protocol does. */
export const owner = async (w: any, text: string, principal: any = phone) => {
  const key = `key-${String(++n).padStart(8, '0')}`;
  await w.home.chats.rules.guard('chat.send', { chatId: w.M, key, text }, principal);
  return key;
};
/** Lets the words of a settled turn be dropped (the Host does it when the turn ends). */
export const settleWords = async (w: any) => {
  const kept = () => Object.keys(w.home.data.sealed('owner-words.json', (v: any) => v ?? { chats: {} }).read().chats).length;
  for (const end = Date.now() + 3000; kept() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
};
export const lines = (w: any) =>
  w.home
    .service('notes')
    .view()
    .flatMap((x: any) => x.lines ?? []).length;
export const add = { type: 'add', title: 'Dana', kind: 'person', text: 'Prefers email', quote: 'I prefer email' };
