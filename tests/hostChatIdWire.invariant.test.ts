// A chat has two spellings of its id, the app's (`acp:host-codex:<id>`) and a Host's (`<id>`) (#5160): every chat.* request that leaves the Mac for a Host carries the Host's. This guard reads every module of electron/host that names a chat.* Host method in a call, and requires each to be on a short list that says why its ids are the Host's, so a new call site that bypasses the Host-id view fails here until it is routed through it or given a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..', 'electron', 'host');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');
/** A chat.* Host method named as the call's method: `call('chat.x'`, `call(hostId, 'chat.x'`, `request('chat.x'`, `needs('chat.x'`. */
const CALL = /\b(?:call|request|needs)\((?:[^()'"]*,\s*)?['"]chat\.[A-Za-z]+['"]/;

/** The modules that call a chat.* Host method, and why the id they carry is the Host's. */
const WHY: Record<string, string> = {
  'remoteChatCalls.cjs': 'reached only through the Host-id view (chatIds.cjs withAppChatIds), which translates the id at the edge',
  'remoteSubscribe.cjs': 'its subscribe is reached through the same view',
  'remoteHistory.cjs': 'chat.history names a generation and a cursor, no chat',
  'imageTransfer.cjs': 'its `host` is the view: chat.attach and chat.image go through its `call`, which translates',
  'continue.cjs':
    "asks through `channel.call`, which is hostContinue.cjs's remote() (translated) or localContinue.cjs's own Host (this Mac keeps the app's ids)",
  'hostContinue.cjs': 'every request leaves through onWire (the Host-id view for a raw session)',
  'localContinue.cjs': "this Mac's own continue Host: the app's ids are its own",
};

test('every module that calls a chat.* Host method is on the list, and each entry still does', () => {
  const found = fs
    .readdirSync(root)
    .filter((f) => f.endsWith('.cjs'))
    .filter((f) => CALL.test(read(f)) || /['"]chat\.(?:prepareContinue|commitContinue|release|subscribe)['"]/.test(read(f)));
  const unlisted = found.filter((f) => !(f in WHY));
  assert.deepEqual(
    unlisted,
    [],
    `${unlisted.join(', ')} call a chat.* Host method: send it through the Host-id view (electron/host/chatIds.cjs), or add the module to WHY with the reason its ids are the Host's`,
  );
  for (const name of Object.keys(WHY)) assert.ok(found.includes(name), `${name} no longer calls a chat.* method: drop it from WHY`);
});

test('the Host-id view translates every id it passes on, and the machines hand it out for every connection', () => {
  const view = read('chatIds.cjs');
  for (const method of ['send', 'start', 'stop', 'switchTo', 'goal', 'removeChat', 'subscribe'])
    assert.ok(view.includes(`host.${method}(ids(chatId)`), `${method} passes the Host's id`);
  assert.match(view, /call: \(method, params\) => host\.call\(method, asked\(params\)\)/);
  const machines = read('machines.cjs');
  assert.equal((machines.match(/withAppChatIds\(/g) ?? []).length >= 2, true, 'both the open and the new connection are wrapped');
});

test('a continue to a Host leaves the Mac under the Host’s id: the request, the activating subscribe, the hello and the snapshot read', () => {
  const src = read('hostContinue.cjs');
  assert.match(src, /schema\.parseParams\(method, onWire\(params\)\)/, 'a continue request goes out through onWire');
  assert.match(src, /moved: moved\.map\(onWire\)/, "the hello names the app's moved chats by the Host's id");
  assert.match(src, /chatId: wire/, 'the snapshot reads the chat by the Host’s id');
  assert.match(src, /event\.chatId !== wire/, "and follows the Host's own spelling in its frames");
  // no request leaves a raw session with the params as they came
  assert.doesNotMatch(src, /s\.call\(method, schema\.parseParams\(method, params\)/);
});
