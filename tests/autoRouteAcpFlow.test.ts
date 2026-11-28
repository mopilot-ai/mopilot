// Auto on an ACP agent end to end: the service picks the turn's model and effort and writes the chat's own down, the ACP
// adapter's own applyInitialConfig sets the pick on the session (where it outlives the turn), and the chat's next message
// has the adapter set the chat's own back once the session is open: also after a restart, when main can't read the
// agent's options until the adapter opens the session, and with a value the user picked meanwhile left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAutoRoute } = require('../electron/autoRoute/service.cjs');
const { createSessionSettings } = require('../electron/app/sessionSettings.cjs');
const { applyInitialConfig } = require('../electron/harness/acp/initialConfig.cjs');

const select = (category: string, values: string[], currentValue: string) => ({
  id: category,
  category,
  type: 'select',
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

function world() {
  // the agent session as acp.cjs keeps it: a set value becomes current, and is replayed from its items on reopen
  const session: any = {
    configOptions: [
      select('model', ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1'], 'claude-opus-4-1'),
      select('thought_level', ['low', 'medium', 'high'], 'high'),
    ],
  };
  // main's copy of the session's options: empty after a restart until the adapter opens the session
  const state: any = { acp: session };
  const record: any = { meta: { config: { autoRoute: 'harness' } } };
  const set: string[] = [];
  const host = {
    label: () => 'Kimi',
    assertChatCurrent: () => {},
    setConfigOption: async (_key: string, configId: string, value: string) => {
      set.push(`${configId}=${value}`);
      session.configOptions = session.configOptions.map((o: any) => (o.id === configId ? { ...o, currentValue: value } : o));
    },
  };
  const controller = { ref: () => ({ kind: 'acp:kimi', key: 'k' }), state: { get: () => state, patch: () => {} } };
  const chats = {
    records: new Map([['chat', record]]),
    patchMeta: (_id: string, p: any) => ((record.meta = { ...record.meta, ...p }), true),
  };
  let tier = 'C0';
  const make = () =>
    createAutoRoute({
      controller,
      chats,
      settings: createSessionSettings({ live: { controller, chats, acpHost: host }, prefs: () => ({}) }),
      router: async () => ({ route: async () => ({ tier, thinking: 'T0', intent: 'new_task', difficulty: 0, margin: 0.9 }) }),
      prefs: () => ({}),
      changed: () => {},
    });
  const current = (category: string) => session.configOptions.find((o: any) => o.category === category).currentValue;
  /** One message: Auto's step in main, then the ACP adapter opens the session and sets the message's config on it. */
  const send = async (service: any, id: string) => {
    const item = { id, text: 'thanks!', attachments: [], opts: { human: true } as any };
    await service.beforeDispatch({ chatId: 'chat', kind: 'turn', item });
    state.acp = session;
    const { model, effort, autoRestore: restore } = item.opts;
    await applyInitialConfig(
      host,
      { state: session, key: 'k', harness: 'acp:kimi' },
      model || effort || restore ? { model, effort, restore } : undefined,
    );
    return item;
  };
  return { make, send, current, set, record, session, state, tierTo: (t: string) => (tier = t) };
}

test('an Auto turn on an ACP agent runs on its pick, and the next message sets the chat’s own back first when Auto is off', async () => {
  const w = world();
  const service = w.make();
  const item = await w.send(service, 'm1');
  assert.deepEqual([item.opts.model, item.opts.effort], ['claude-haiku-4-5', 'low']);
  assert.deepEqual([w.current('model'), w.current('thought_level')], ['claude-haiku-4-5', 'low']);
  service.finished({ chatId: 'chat', turnId: 't1', completed: true });
  // Auto picks again: the agent goes straight to the new pick, and the chat's own stays written down
  w.tierTo('C3');
  await w.send(service, 'm2');
  assert.equal(w.current('model'), 'claude-opus-4-1');
  service.finished({ chatId: 'chat', turnId: 't2', completed: true });
  w.record.meta.config.autoRoute = null;
  const off = await w.send(service, 'm3');
  assert.equal(off.opts.model, undefined);
  assert.deepEqual([w.current('model'), w.current('thought_level')], ['claude-opus-4-1', 'high']);
  service.finished({ chatId: 'chat', turnId: 't3', completed: true });
  assert.equal(w.record.meta.config.autoRouteRestore, null);
});

test('after a restart main can’t read the agent’s options, and the adapter still sets the chat’s own back', async () => {
  const w = world();
  await w.send(w.make(), 'm1');
  // the app quits mid-turn: no turn end; after relaunch main has no copy of the options until the session opens
  w.state.acp = null;
  w.record.meta.config.autoRoute = null;
  const restarted = w.make();
  const item = await w.send(restarted, 'm2');
  assert.ok(item.opts.autoRestore);
  assert.deepEqual([w.current('model'), w.current('thought_level')], ['claude-opus-4-1', 'high']);
  restarted.finished({ chatId: 'chat', turnId: 't2', completed: true });
  assert.equal(w.record.meta.config.autoRouteRestore, null);
});

test('a model the user picks between turns is theirs; a start the agent never took keeps the record for the next message', async () => {
  const w = world();
  const service = w.make();
  await w.send(service, 'm1');
  service.finished({ chatId: 'chat', turnId: 't1', completed: true });
  // the user picks Sonnet in the picker, which also ends Auto
  w.session.configOptions = w.session.configOptions.map((o: any) =>
    o.category === 'model' ? { ...o, currentValue: 'claude-sonnet-4-5' } : o,
  );
  w.record.meta.config.autoRoute = null;
  await w.send(service, 'm2');
  service.finished({ chatId: 'chat', turnId: 'pending-m2', completed: false });
  assert.ok(w.record.meta.config.autoRouteRestore['acp:kimi'].effort);
  await w.send(service, 'm2');
  service.finished({ chatId: 'chat', turnId: 't2', completed: true });
  assert.deepEqual([w.current('model'), w.current('thought_level')], ['claude-sonnet-4-5', 'high']);
  assert.equal(w.record.meta.config.autoRouteRestore, null);
});
