// MoMo's suggestions in main (electron/app/momoBackground.cjs, A7): behind prefs.momo.suggestions MoMo's main chat gets momo_suggest and the windows get momoSuggestions:list and :act; Start sends the first step into MoMo's main chat as the user's own message (opts.human) and is held while MoMo is paused; the file is sealed in MoMo's folder and Reset MoMo erases it; with the flag off there is no tool and nothing is available.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world } from './support/momoAppWorld.ts';

const require = createRequire(import.meta.url);
const { resetMomoStores } = require('../electron/momo/stores.cjs');
const done = async (w: any) => {
  await w.m.close();
  require('../electron/momo/contract/context.cjs').setMomoContextProvider(null);
};
const suggestion = {
  title: 'Reply to Sam',
  why: 'He asked on Monday.',
  source: 'Mail: Sam, Lease',
  step: 'Draft a reply to Sam',
  from: 'mail',
  ref: 't1',
  kind: 'reply',
};
const asMain = (w: any, id = 'mc') =>
  w.chats.commit({ id, segments: [{ kind: 'claude', nativeId: 's1', start: 0, count: null }], meta: { momo: 'main' } });

test('with the panel flag off MoMo has no suggestion tool and the windows are told it is unavailable', async () => {
  const w = world({ allowed: true });
  asMain(w);
  assert.equal((await w.live.capabilities.invoke('mc', 'claude:s1', 'momo_suggest', suggestion)).ok, false);
  assert.equal((await w.call('momoSuggestions:list')).reason, 'unavailable');
  assert.equal((await w.call('momoSuggestions:act', 'x', 'start')).reason, 'unavailable');
  await done(w);
});

test('MoMo adds one through its tool; the user sees it, and Start sends its first step into the main chat as their own message', async () => {
  const w = world({ allowed: true, prefs: { momo: { brain: { main: { harness: 'claude' } }, suggestions: true } } });
  const main = (await w.call('momoChat:mainChat')).value.chatId;
  const seg = w.chats.record(main).segments.at(-1);
  const r = await w.live.capabilities.invoke(main, `${seg.kind}:${seg.nativeId}`, 'momo_suggest', suggestion);
  assert.equal(r.ok, true);
  assert.ok(w.broadcasts.some(([c]: any) => c === 'momoSuggestions:changed'));
  // a coding chat never gets it
  w.chats.commit({ id: 'cc', segments: [{ kind: 'claude', nativeId: 's2', start: 0, count: null }], meta: {} });
  assert.equal((await w.live.capabilities.invoke('cc', 'claude:s2', 'momo_suggest', suggestion)).ok, false);
  const listed = await w.call('momoSuggestions:list');
  assert.deepEqual(
    listed.suggestions.map((s: any) => [s.title, s.source, s.channel]),
    [['Reply to Sam', 'Mail: Sam, Lease', 'main']],
  );
  // nothing was sent by adding it
  assert.deepEqual(w.sends, []);
  const started = await w.call('momoSuggestions:act', listed.suggestions[0].id, 'start');
  assert.deepEqual([started.ok, started.action], [true, 'start']);
  assert.equal(w.sends.length, 1);
  assert.equal(w.sends[0].chatId, main);
  assert.match(w.sends[0].item.text, /^Start: Reply to Sam\nFirst step: Draft a reply to Sam\n\(From your suggestion, Mail: Sam, Lease\)$/);
  assert.deepEqual(w.sends[0].item.opts, { human: true });
  assert.equal((await w.call('momoSuggestions:list')).suggestions.length, 0);
  await done(w);
});

test('while MoMo is paused Start sends nothing and keeps the suggestion; Resume lets it go', async () => {
  const w = world({ allowed: true, prefs: { momo: { brain: { main: { harness: 'claude' } }, suggestions: true, paused: true } } });
  const main = (await w.call('momoChat:mainChat')).value.chatId;
  const seg = w.chats.record(main).segments.at(-1);
  await w.live.capabilities.invoke(main, `${seg.kind}:${seg.nativeId}`, 'momo_suggest', suggestion);
  const [s] = (await w.call('momoSuggestions:list')).suggestions;
  const held = await w.call('momoSuggestions:act', s.id, 'start');
  assert.deepEqual([held.ok, held.error], [false, 'MoMo is paused. Resume it first.']);
  assert.deepEqual(w.sends, []);
  assert.equal((await w.call('momoSuggestions:list')).suggestions.length, 1);
  w.prefs = { ...w.prefs, momo: { ...w.prefs.momo, paused: false } };
  assert.equal((await w.call('momoSuggestions:act', s.id, 'start')).ok, true);
  assert.equal(w.sends.length, 1);
  await done(w);
});

test('the suggestions are in a sealed file in MoMo’s folder that Reset MoMo erases', async () => {
  const w = world({ allowed: true, prefs: { momo: { brain: { main: { harness: 'claude' } }, suggestions: true } } });
  const main = (await w.call('momoChat:mainChat')).value.chatId;
  const seg = w.chats.record(main).segments.at(-1);
  await w.live.capabilities.invoke(main, `${seg.kind}:${seg.nativeId}`, 'momo_suggest', suggestion);
  const file = path.join(w.m.dir, 'suggestions.json');
  assert.equal(fs.existsSync(file), true);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /Reply to Sam|Draft a reply/);
  await resetMomoStores();
  assert.equal(fs.existsSync(file), false);
  assert.equal((await w.call('momoSuggestions:list')).suggestions.length, 0);
  await done(w);
});

test('not allowed: the tool and the windows’ calls are refused', async () => {
  const w = world({ allowed: false, prefs: { momo: { suggestions: true } } });
  asMain(w);
  assert.equal((await w.live.capabilities.invoke('mc', 'claude:s1', 'momo_suggest', suggestion)).ok, false);
  assert.equal((await w.call('momoSuggestions:list')).reason, 'not_allowed');
  await done(w);
});

test('a suggestion for a channel starts in that channel’s own chat; a channel that is not open is refused when MoMo adds it and when the user starts it', async () => {
  const w = world({ allowed: true, prefs: { momo: { brain: { main: { harness: 'claude' } }, suggestions: true, channels: true } } });
  const main = (await w.call('momoChat:mainChat')).value.chatId;
  const seg = w.chats.record(main).segments.at(-1);
  const call = (args: object) => w.live.capabilities.invoke(main, `${seg.kind}:${seg.nativeId}`, 'momo_suggest', args);
  const made = await w.call('momoChannels:create', 'Trip');
  const id = made.value?.channel?.id ?? made.channel?.id;
  assert.match(id, /^ch_[0-9a-f]{16}$/);
  assert.equal((await call({ ...suggestion, channel: id })).ok, true);
  const refused = await call({ ...suggestion, ref: 't2', channel: 'ch_ffffffffffffffff' });
  assert.equal(refused.ok, false);
  assert.match(refused.content?.[0]?.text ?? refused.error?.message ?? '', /not open/);
  const [s] = (await w.call('momoSuggestions:list')).suggestions;
  assert.equal(s.channel, id);
  const started = await w.call('momoSuggestions:act', s.id, 'start');
  assert.equal(started.ok, true);
  assert.equal(started.channel, id);
  assert.equal(w.sends.length, 1);
  assert.notEqual(w.sends[0].chatId, main, 'in the channel’s own chat');
  await done(w);
});
