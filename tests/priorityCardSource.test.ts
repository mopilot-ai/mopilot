// The Priority card's snippet reads the start of a chat's latest reply, so deltas past it re-render nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/shell-sidebar-kit.ts';
const { SNIPPET_SOURCE_CHARS, lastAgentText } = await import('../src/components/sidebar/ChatLists.tsx');

const reply = (text: string) => ({ type: 'agentMessage', text }) as any;

test('the latest agent reply is read by its start; later growth gives the same string', () => {
  assert.equal(lastAgentText(undefined), '');
  assert.equal(lastAgentText([{ items: [{ type: 'userMessage' } as any] }]), '');
  assert.equal(lastAgentText([{ items: [reply('old')] }, { items: [reply('newer'), reply('')] }]), 'newer');
  const long = 'x'.repeat(SNIPPET_SOURCE_CHARS);
  assert.equal(lastAgentText([{ items: [reply(long)] }]), long);
  assert.equal(lastAgentText([{ items: [reply(`${long} and more as it streams`)] }]), long);
});

test('a heartbeat longer than the snippet cap is decoded before its preview is clipped', () => {
  const message = 'Promoted two changes. ' + 'x'.repeat(SNIPPET_SOURCE_CHARS);
  const raw = `<heartbeat><automation_id>daily</automation_id><decision>NOTIFY</decision><message>${message}</message></heartbeat>`;
  assert.equal(lastAgentText([{ items: [reply(raw)] }]), message.slice(0, SNIPPET_SOURCE_CHARS));
  assert.equal(lastAgentText([{ items: [reply(raw.slice(0, -1))], status: 'inProgress' }]), '');
  assert.equal(lastAgentText([{ items: [reply(raw)], status: 'inProgress' }]), '');
  assert.equal(lastAgentText([{ items: [reply(raw)], status: 'completed' }]), message.slice(0, SNIPPET_SOURCE_CHARS));
});
