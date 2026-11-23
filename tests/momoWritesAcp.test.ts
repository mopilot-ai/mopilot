// MoMo's write tools over an ACP chat's channel (#2139 P5): sage-mcp in session/new, the same capability registry as Claude Code and Codex. A MoMo main chat on ACP lists the write tools, its call of one goes through MoMo's trust gate (the registry's chat gate), raises the approval card, writes only after Allow once and says so; Read only refuses it with no card. tests/momoToolListTiming.test.ts proves the listing on all three harness families; this proves the card flow end to end on the ACP channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, until, ADD } from './support/momo-writes-rig.ts';

const require = createRequire(import.meta.url);
const { answerToolRequest } = require('../electron/capabilities/mcp/socket.cjs');
const { SessionMcp } = require('../electron/capabilities/channels/sessionMcp.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { createMomoCallGate } = require('../electron/momo/toolTrust.cjs');

async function acpChat(level: 'ask' | 'read') {
  const r = rig({ level });
  r.registry.setChatScope(
    () => true,
    (id: string) => id === 'momo-main',
  );
  r.registry.setChatGate(createMomoCallGate({ trust: r.trust, sentinel: r.sentinel, identity: () => ({}) }));
  const sessions = new ToolSessions();
  const mcp = new SessionMcp({ sessions, socket: { on: () => undefined, listen: async () => '/tmp/s.sock' }, command: '/bin/sage-mcp' });
  await mcp.prepare('momo-main', { harnessPid: 1, chatId: 'momo-main' });
  const session = sessions.get('momo-main');
  const request = (method: string, params?: object) =>
    answerToolRequest({ registry: r.registry, session, calls: new Map(), msg: { id: 1, method, params } });
  return { r, request };
}
const textOf = (a: any) => a.result.content.map((c: any) => c.text).join('\n');

test('an ACP MoMo chat lists the write tools, and a call asks on the card and writes only after Allow once', async () => {
  const { r, request } = await acpChat('ask');
  const names = (await request('tools/list')).result.tools.map((t: any) => t.name);
  assert.ok(names.includes(ADD) && names.includes('momo_calendar_create_event'));
  const pending = request('tools/call', { name: ADD, arguments: { title: 'Milk' } });
  await until(() => r.cards.length === 1);
  assert.equal(r.cards[0].params.momo.summary, 'Milk');
  assert.deepEqual(r.wrote(), []);
  r.broker.answer(r.cards[0].id, { decision: 'allow', scope: 'once' });
  const answer = await pending;
  assert.match(textOf(answer), /^Reminder added\./);
  assert.notEqual(answer.result.isError, true);
  assert.equal(r.wrote().length, 1);
});

test('on ACP a source at Read only refuses the call with no card', async () => {
  const { r, request } = await acpChat('read');
  const answer = await request('tools/call', { name: ADD, arguments: { title: 'Milk' } });
  assert.equal(answer.result.isError, true);
  assert.match(textOf(answer), /read only for MoMo, so nothing was changed/);
  assert.equal(r.cards.length, 0);
  assert.deepEqual(r.wrote(), []);
});
