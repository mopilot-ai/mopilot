// Claude Code's own turn-over signal (#1834): shared/claudeTurnOver.mjs, which main's controller and the windows' translator share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { claudeTurnOver } from '../shared/claudeTurnOver.mjs';
import { ClaudeTranslator } from './support/claude-translate.ts';

const require = createRequire(import.meta.url);
const { buildSessionOptions } = require('../electron/harness/claude/sessionOptions.cjs');

test("an 'idle' ends a turn only after the CLI ran for that same turn; a CLI that never reports ends nothing", () => {
  const h: { cliRanFor?: unknown } = {};
  // the previous turn's late idle, before this turn ran
  assert.equal(claudeTurnOver(h, 'idle', 't1'), false);
  assert.equal(claudeTurnOver(h, 'running', 't1'), false);
  assert.equal(claudeTurnOver(h, 'requires_action', 't1'), false);
  assert.equal(claudeTurnOver(h, 'idle', 't1'), true);
  // a new turn: what ran for the last one doesn't count
  assert.equal(claudeTurnOver(h, 'idle', 't2'), false);
  // no turn at all
  assert.equal(claudeTurnOver({}, 'running', null), false);
  assert.equal(claudeTurnOver({ cliRanFor: null }, 'idle', null), false);
});

test("main's controller: a steer folded into the running loop (one result for two prompts) ends on the CLI's idle; a late idle never ends a new turn", async () => {
  const { setup, tick } = await import('./support/controller/fixture.ts');
  const { c, s } = setup();
  const chat = 'claude:s1';
  const state = (st: string) =>
    c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'system', subtype: 'session_state_changed', state: st } });
  c.send(chat, { text: 'hi', opts: { human: true } }, 1);
  await c.claudeSend(chat, chat, {}, { role: 'user', content: 'hi' }, undefined, { human: true, uuid: 'u1' });
  // the previous turn's late idle, before this turn ran
  state('idle');
  assert.equal(s(chat).turn, 'running');
  state('running');
  // the user steers; Claude Code backgrounds the waiting tool call and folds the steer into the running loop
  await c.claudeSend(chat, chat, {}, { role: 'user', content: 'more' }, 'now', { uuid: 'u2' });
  c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'result', subtype: 'success' } });
  assert.equal(s(chat).turn, 'running', 'one result for two prompts');
  state('idle');
  assert.equal(s(chat).turn, 'idle');
  // an idle with no turn, or from a CLI the chat no longer runs on, changes nothing
  state('idle');
  c.onClaudeEvent({ key: 'claude:other', kind: 'message', msg: { type: 'system', subtype: 'session_state_changed', state: 'idle' } });
  await tick();
  assert.equal(s(chat).turn, 'idle');
});

test("a steer Claude Code folded into the running loop gets no result of its own: the CLI's idle ends the turn (#1834)", () => {
  const events: string[] = [];
  const tr = new ClaudeTranslator('claude:x', '/repo', (m: string) => events.push(m));
  const state = (s: string) => tr.onMessage({ type: 'system', subtype: 'session_state_changed', state: s });
  // the previous turn's late idle, before this turn ran: nothing
  tr.beginTurn('t1');
  state('idle');
  assert.equal(tr.turnId, 't1');
  state('running');
  tr.addSteer();
  tr.onMessage({ type: 'result', subtype: 'success', usage: {} });
  assert.ok(tr.turnId, 'one result for two prompts: the count still waits');
  state('requires_action');
  state('idle');
  assert.equal(tr.turnId, null);
  assert.deepEqual(events.filter((e) => e === 'turn/completed').length, 1);
  // a stopped turn ends as interrupted; an idle with no turn does nothing
  tr.beginTurn('t2');
  state('running');
  tr.markInterrupted();
  state('idle');
  assert.equal(tr.turnId, null);
  state('idle');
  assert.equal(events.filter((e) => e === 'turn/completed').length, 2);
});

test('every Claude session asks the CLI for its session state, on top of its own environment and the findings flag', () => {
  assert.deepEqual(buildSessionOptions({ cwd: '/repo' }, { env: { A: '1' } }).env, {
    // the cap on MCP server instructions (tests/turnBoxNote.test.ts)
    CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: '16384',
    A: '1',
    CLAUDE_CODE_REPORT_FINDINGS: '1',
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
  });
});

test("a turn Claude Code started on its own (a background task's wake-up) ends on its idle too, in main and in the window", async () => {
  const { setup } = await import('./support/controller/fixture.ts');
  const { c, s, state } = setup();
  const chat = 'claude:s1';
  state.patch(chat, { permission: 'default' });
  const msg = (m: any) => c.onClaudeEvent({ key: chat, kind: 'message', msg: m });
  // 'running' comes before the CLI's first words open the turn
  msg({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  msg({ type: 'assistant', message: { content: [{ type: 'text', text: 'The task finished.' }] } });
  assert.equal(s(chat).turn, 'running');
  msg({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  assert.equal(s(chat).turn, 'idle');
  const events: string[] = [];
  const tr = new ClaudeTranslator('claude:x', '/repo', (m: string) => events.push(m));
  tr.onMessage({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  tr.onMessage({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'The task finished.' }] } });
  assert.ok(tr.turnId);
  tr.onMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  assert.equal(tr.turnId, null);
});
