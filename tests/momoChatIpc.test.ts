// MoMo's main chat IPC (electron/momo/mainChatIpc.cjs, #2139): momoChat:mainChat, momoChat:brain:get, momoChat:brain:set,
// momoChat:model:set and momoChat:previous answer the service's value or its error with code, and every one is refused while MoMo is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerMomoMainChatIpc, brainChangedTo, BRAIN_CHANGED } = require('../electron/momo/mainChatIpc.cjs');

test('MoMo’s bridge contracts are types only: loading them runs nothing', async () => {
  const mod = await import('../src/lib/native/contracts/momoChat.ts');
  assert.deepEqual(
    Object.keys(mod).filter((k) => k !== 'default' && k !== 'module.exports'),
    [],
  );
});

test('each call answers its value or its error with code, and every one is refused while MoMo is off', async () => {
  const h = new Map<string, any>();
  let allowed = true;
  const calls: any[] = [];
  const service = {
    ensureMainChat: async () => (calls.push(['ensure']), { chatId: 'th1', warning: null }),
    getBrain: () => (calls.push(['get']), { harness: 'codex' }),
    setBrain: async (b: any) => {
      calls.push(['set', b]);
      if (!b) throw Object.assign(new Error('Pick a harness for MoMo.'), { code: 'invalid_brain' });
      return { applied: 'now' };
    },
    setChatModel: async (...a: any[]) => (calls.push(['model', ...a]), { chatId: a[0], model: a[1], warning: null }),
    previousChats: () => (calls.push(['previous']), [{ chatId: 'old', harness: 'Codex', at: 1 }]),
  };
  registerMomoMainChatIpc({ handle: (ch: string, f: any) => h.set(ch, f) }, { service: service as any, allowed: () => allowed });
  assert.deepEqual(
    [...h.keys()],
    [
      'momoChat:mainChat',
      'momoChat:brain:get',
      'momoChat:brain:set',
      'momoChat:previous',
      'momoChat:model:set',
      'momoChat:activity:list',
      'momoChat:activity:watch',
    ],
  );
  assert.deepEqual(await h.get('momoChat:previous')({}), { value: [{ chatId: 'old', harness: 'Codex', at: 1 }] });
  assert.deepEqual(await h.get('momoChat:mainChat')({}), { value: { chatId: 'th1', warning: null } });
  assert.deepEqual(await h.get('momoChat:brain:get')({}), { value: { harness: 'codex' } });
  assert.deepEqual(await h.get('momoChat:brain:set')({}, { harness: 'claude' }), { value: { applied: 'now' } });
  assert.deepEqual(await h.get('momoChat:brain:set')({}, null), { error: { message: 'Pick a harness for MoMo.', code: 'invalid_brain' } });
  // a model picked in a MoMo chat's composer (#2304)
  assert.deepEqual(await h.get('momoChat:model:set')({}, 'c', 'haiku', 'Haiku'), { value: { chatId: 'c', model: 'haiku', warning: null } });
  assert.deepEqual(calls.at(-1), ['model', 'c', 'haiku', 'Haiku']);
  // a failure without a code, or a thrown non-error
  service.getBrain = () => {
    throw 'plain';
  };
  assert.deepEqual(await h.get('momoChat:brain:get')({}), { error: { message: 'plain', code: null } });
  allowed = false;
  calls.length = 0;
  for (const ch of h.keys())
    assert.deepEqual(await h.get(ch)({}, { harness: 'codex' }), {
      error: { message: 'MoMo is not available for this account.', code: 'not_allowed' },
    });
  assert.deepEqual(calls, []);
});

test('a brain change reaches every window on its own channel', () => {
  const sent: any[] = [];
  brainChangedTo((channel: string, payload: unknown) => sent.push([channel, payload]))({ harness: 'claude' });
  assert.deepEqual(sent, [['momoChat:brainChanged', { harness: 'claude' }]]);
  assert.equal(BRAIN_CHANGED, 'momoChat:brainChanged');
});

test('MoMo’s activity over IPC: the list as main reads it, empty before it is made; a window says it shows it and a window that goes away stops', async () => {
  const h = new Map<string, any>();
  let allowed = true;
  let activity: any;
  const watched: any[] = [];
  const service = {} as any;
  registerMomoMainChatIpc({ handle: (ch: string, f: any) => h.set(ch, f) }, { service, allowed: () => allowed, activity: () => activity });
  assert.deepEqual(await h.get('momoChat:activity:list')({}), { value: { items: [] } }, 'before the background services exist');
  activity = { list: async () => ({ items: [{ id: 'routine:r' }] }), watch: (key: number, on: boolean) => watched.push([key, on]) };
  assert.deepEqual(await h.get('momoChat:activity:list')({}), { value: { items: [{ id: 'routine:r' }] } });
  allowed = false;
  assert.deepEqual(await h.get('momoChat:activity:watch')({ sender: { id: 4 } }, true), {
    error: { message: 'MoMo is not available for this account.', code: 'not_allowed' },
  });
  allowed = true;
  const gone: (() => void)[] = [];
  const sender = { id: 4, once: (_e: string, fn: () => void) => gone.push(fn) };
  assert.deepEqual(await h.get('momoChat:activity:watch')({ sender }, true), { value: true });
  assert.deepEqual(watched, [[4, true]]);
  gone[0]();
  assert.deepEqual(watched.at(-1), [4, false]);
  assert.deepEqual(await h.get('momoChat:activity:watch')({ sender }, false), { value: true });
  assert.deepEqual(watched.at(-1), [4, false]);
  // an event with no sender (a test's) is the window 0; before the activity exists nothing is watched
  await h.get('momoChat:activity:watch')({}, true);
  assert.deepEqual(watched.at(-1), [0, true]);
  activity = undefined;
  assert.deepEqual(await h.get('momoChat:activity:watch')({ sender }, true), { value: true });
});
