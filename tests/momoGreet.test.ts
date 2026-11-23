// MoMo's first words when setup's Start finishes (electron/momo/starterRoutines.cjs, #2527): MoMo greets in its main chat as a message it sent itself, once per main chat on whatever brain it has; refused while MoMo is off; a greeting that did not go can be tried again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGreeter, GREETING } = require('../electron/momo/starterRoutines.cjs');

function world(o: { allowed?: boolean; chatId?: string; sendFails?: boolean } = {}) {
  const w: any = {
    allowed: o.allowed ?? true,
    chatId: o.chatId ?? 'main-1',
    sent: [] as any[],
    authored: [] as any[],
    sendFails: o.sendFails ?? false,
  };
  w.greet = createGreeter({
    allowed: () => w.allowed,
    ensureMainChat: async () => ({ chatId: w.chatId }),
    authored: (chatId: string, text: string, show: object) => (
      w.authored.push([chatId, text, show]), { id: `item-${w.authored.length}`, text }
    ),
    send: async (chatId: string, item: object) => {
      if (w.sendFails) throw new Error('no turn');
      w.sent.push([chatId, item]);
    },
  });
  return w;
}

test('MoMo greets in its main chat as itself, asked to be short and to name what it can do', async () => {
  const w = world();
  assert.equal(await w.greet(), true);
  assert.deepEqual(w.authored, [['main-1', GREETING, { by: 'momo', title: 'Welcome' }]]);
  assert.deepEqual(w.sent, [['main-1', { id: 'item-1', text: GREETING }]]);
  assert.match(GREETING, /one or two short sentences/);
  assert.match(GREETING, /Ask at most one question/);
});

test('once per main chat: a second Start, another window or a retry never greets again; a new main chat (a brain change) is greeted', async () => {
  const w = world();
  assert.equal(await w.greet(), true);
  assert.equal(await w.greet(), false);
  assert.equal(w.sent.length, 1);
  w.chatId = 'main-2';
  assert.equal(await w.greet(), true);
  assert.deepEqual(
    w.sent.map((s: any) => s[0]),
    ['main-1', 'main-2'],
  );
});

test('refused while MoMo is off, with the code the window reads; a greeting that did not go can be tried again', async () => {
  const off = world({ allowed: false });
  await assert.rejects(off.greet(), (e: any) => e.code === 'not_allowed' && /not available/.test(e.message));
  assert.deepEqual(off.sent, []);
  const w = world({ sendFails: true });
  await assert.rejects(w.greet(), /no turn/);
  w.sendFails = false;
  assert.equal(await w.greet(), true, 'tried again');
  assert.equal(w.sent.length, 1);
});
