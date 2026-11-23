// Tools beyond MoMo's own four behind the gate (host/src/momoToolEffects.mjs `createExtraTools`, `home.gate.tools.register`): a lane says what its tool does, a send is a card the owner taps, a read of outside content taints the chat, an unregistered tool is refused, and a lane cannot claim the free class of MoMo's notes or a MoMo tool's name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExtraTools } from '../host/src/momoToolEffects.mjs';
import { owner, said, world } from './support/host/notesToolWorld.ts';

/** A tool in the Host's registry, as the lane that owns it would add it: it runs only if the gate lets it. */
function toolIn(w: any, name: string) {
  const ran: any[] = [];
  w.registry.register({
    name,
    policy: 'act',
    authorizesItself: true,
    description: name,
    schema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } } },
    handler: (args: any) => (ran.push(args), 'done'),
  });
  return ran;
}
const send = { to: 'dana@example.com', body: 'Hi Dana' };

test('a tool no lane registered with the gate is refused, and once registered a send is a card the owner taps, then runs once on the model’s retry', async (t) => {
  const w = await world(t);
  const ran = toolIn(w, 'momo_gmail_send');
  assert.equal(said(await w.call(w.M, 'momo_gmail_send', send)), 'refused:unavailable');
  const off = w.home.gate.tools.register({
    tool: 'momo_gmail_send',
    effect: 'send',
    egress: 'network',
    scope: (a: any) => a.to,
    summary: (a: any) => `Send a mail to ${a.to}`,
  });
  assert.equal(said(await w.call(w.M, 'momo_gmail_send', send)), 'refused:approval_pending');
  assert.deepEqual(ran, []);
  const [card] = (await w.home.service('gate').cards('phone:a')).filter((c: any) => c.status === 'pending');
  assert.ok(card.fields.some((f: any) => f.label === 'to' && f.value === 'dana@example.com'));
  assert.equal(card.title, 'Send a mail to dana@example.com');
  await w.home.service('gate').answer(card.id, 'allow', 'phone:a', 'Phone');
  assert.equal(said(await w.call(w.M, 'momo_gmail_send', send)), 'done');
  assert.equal(ran.length, 1);
  assert.equal(said(await w.call(w.M, 'momo_gmail_send', send)), 'refused:approval_pending', 'one tap, one run');
  assert.equal(w.home.gate.taintFor(w.M).tainted(), true, 'what comes back from another lane is outside content');
  off();
  assert.equal(said(await w.call(w.M, 'momo_gmail_send', { ...send, to: 'z@example.com' })), 'refused:unavailable');
});

test('a read of outside content runs without a card and taints the chat, so the next change in it asks; a run in the background may only read', async (t) => {
  const w = await world(t);
  await owner(w, 'Plan my week');
  const read = toolIn(w, 'momo_mail_read');
  const write = toolIn(w, 'momo_calendar_add');
  w.home.gate.tools.register({ tool: 'momo_mail_read', effect: 'read' });
  w.home.gate.tools.register({ tool: 'momo_calendar_add', effect: 'write', summary: () => 'x'.repeat(300), scope: () => 'y'.repeat(300) });
  assert.equal(w.home.gate.taintFor(w.M).tainted(), false);
  assert.equal(said(await w.call(w.M, 'momo_mail_read', {})), 'done');
  assert.equal(read.length, 1);
  assert.equal(w.home.gate.taintFor(w.M).tainted(), true);
  assert.equal(said(await w.call(w.M, 'momo_calendar_add', { body: 'Lunch' })), 'refused:approval_pending');
  assert.deepEqual(write, []);
  const [card] = (await w.home.service('gate').cards('phone:a')).filter((c: any) => c.status === 'pending');
  assert.ok(card.title.length <= 120, 'a long summary is cut');
  const run = w.home.chats.startBackground('claude', 'routine');
  assert.equal(said(await w.call(run, 'momo_calendar_add', { body: 'Lunch' })), 'refused:read_only');
  assert.equal(said(await w.call(run, 'momo_mail_read', {})), 'done');
});

test('what a lane may claim: not a MoMo tool’s name, not the free class of MoMo’s notes, not an unknown effect, not another meaning for a name; the same again is fine', () => {
  const tools = createExtraTools();
  assert.throws(() => tools.register({ tool: 'Not A Name', effect: 'read' }), /not a tool name/);
  assert.throws(() => tools.register({ tool: 'momo_notes', effect: 'read' }), /one of MoMo's own tools/);
  assert.throws(() => tools.register({ tool: 'momo_memory_save', effect: 'send' }), /one of MoMo's own tools/);
  assert.throws(() => tools.register({ tool: 'x_tool', effect: 'notes' as any }), /not an effect a tool may claim/);
  assert.throws(() => tools.register({ tool: 'x_tool', effect: 'free' as any }), /not an effect a tool may claim/);
  tools.register({ tool: 'x_tool', effect: 'send' });
  tools.register({ tool: 'x_tool', effect: 'send' });
  assert.throws(() => tools.register({ tool: 'x_tool', effect: 'read' }), /already registered as something else/);
  assert.throws(() => tools.register({ tool: 'x_tool', effect: 'send', egress: 'network' }), /already registered as something else/);
  assert.equal(tools.has('x_tool'), true);
  assert.equal(tools.get('x_tool')?.effect, 'send');
  assert.equal(tools.has('y_tool'), false);
});
