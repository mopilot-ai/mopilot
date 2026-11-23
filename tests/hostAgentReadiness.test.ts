// What each agent on a machine is ready for (shared/host/agentReadiness.mjs) and how the machine list carries it (electron/host/machines.cjs list()): an agent signed out or missing never hides the machine or the other agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { agentLabel, agentsOf } from '../shared/host/agentReadiness.mjs';
const require = createRequire(import.meta.url);
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');

test("an agent's logins reach its row, read defensively; a Host that sends none leaves none", () => {
  const [claude, codex] = agentsOf(
    [
      {
        id: 'claude',
        detected: true,
        signedIn: true,
        logins: [
          {
            id: 'a',
            label: 'me@work.com',
            state: 'ok',
            billing: 'subscription',
            active: true,
            usage: [{ label: '5h', usedPercent: 40, resetsAt: null }],
          },
          { label: 'no id' },
        ],
      },
      { id: 'codex', detected: true, signedIn: true },
    ],
    'box',
  );
  assert.deepEqual(claude.logins, [
    {
      id: 'a',
      label: 'me@work.com',
      state: 'ok',
      limited: false,
      billing: 'subscription',
      active: true,
      usage: [{ label: '5h', usedPercent: 40, resetsAt: null }],
    },
  ]);
  assert.equal('logins' in codex, false);
});

test('Claude Code ready, Codex not installed, a basic agent signed out: each is told apart with the line that says why', () => {
  assert.deepEqual(
    agentsOf(
      [
        { id: 'claude', detected: true, signedIn: true },
        { id: 'codex', detected: false, signedIn: false },
        { id: 'kimi', detected: true, signedIn: false },
        { id: 'unknown-agent', detected: true, signedIn: true },
      ],
      'build-box',
    ),
    [
      { id: 'claude', label: 'Claude Code', state: 'ready', reason: '' },
      { id: 'codex', label: 'Codex', state: 'missing', reason: 'Not installed on build-box' },
      { id: 'kimi', label: 'Kimi Code', state: 'signin', reason: 'Sign in on build-box' },
      { id: 'unknown-agent', label: 'unknown-agent', state: 'ready', reason: '' },
    ],
  );
  // the Host's word that it takes Plan for an agent reaches the agent's row; a Host that does not say it leaves the row without it
  assert.deepEqual(
    agentsOf(
      [
        { id: 'codex', detected: true, signedIn: true, planMode: true },
        { id: 'claude', detected: true, signedIn: true },
      ],
      'm',
    ).map((a) => a.planMode),
    [true, undefined],
  );
  assert.equal(agentLabel('codex'), 'Codex');
  // the Host can tell why Claude Code reads as signed out on a Mac whose keychain it cannot open
  assert.deepEqual(
    agentsOf([{ id: 'claude', detected: true, signedIn: false, reason: 'keychain-locked' }], 'mini').map((a) => a.reason),
    ["mini's keychain is locked. Log in on its screen once, or sign in again."],
  );
  assert.equal(agentsOf([{ id: 'claude', detected: true, signedIn: false, reason: 'other' }], 'mini')[0].reason, 'Sign in on mini');
});

test('the machine list carries the readiness of every agent, and a machine with one agent signed out is still online', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const harnesses = [
    { id: 'claude', detected: true, signedIn: true },
    { id: 'codex', detected: false, signedIn: false },
    { id: 'kimi', detected: true, signedIn: true },
  ];
  const registry = createRegistry({ file: path.join(dir, 'r.json'), status: async () => ({ harnesses, capabilities: { shell: true } }) });
  registry.add({ id: 'ssh:box', name: 'box', address: 'me@box', socketPath: '/h/host.sock', harnesses });
  const m = createMachines({ dir, allowed: () => true, watch: () => undefined, registry, installer: {}, pool: { get: () => ({}) } });
  t.after(() => m.dispose());
  await registry.check();
  const row = m.list().machines[0];
  assert.equal(row.status, 'online');
  assert.equal(row.note, 'SSH · Claude Code, Kimi Code', 'the note names the agents the machine has, not every harness its Host knows');
  assert.deepEqual(
    row.agents.map((a: any) => [a.id, a.state, a.reason]),
    [
      ['claude', 'ready', ''],
      ['codex', 'missing', 'Not installed on box'],
      ['kimi', 'ready', ''],
    ],
  );
});

test('the machine readiness projection preserves its native models even when its sign-in is supplied by a lent key', () => {
  const models = [{ id: 'only-there', name: 'Only there', default: true, efforts: ['low', 'high'], defaultEffort: 'high' }];
  const [agent] = agentsOf([{ id: 'claude', detected: true, signedIn: false, keyed: true, models }], 'box');
  assert.deepEqual(agent.models, models);
  assert.equal(agent.lent, true);
});

test('a signed-out agent that lists its logins says which, a name too long or an empty list falls back to where to sign in (#4815)', () => {
  const reason = (signIn?: unknown) =>
    agentsOf([{ id: 'gemini', detected: true, signedIn: false, ...(signIn === undefined ? {} : { signIn }) } as any], 'mini')[0].reason;
  assert.equal(reason(['Google login', 'API key']), 'Sign in on mini: Google login or API key');
  assert.equal(reason(['a', 'b', 'c', 'd']), 'Sign in on mini: a or b or c');
  assert.equal(reason([]), 'Sign in on mini');
  assert.equal(reason([' ', 3]), 'Sign in on mini');
  assert.equal(reason('nope'), 'Sign in on mini');
  assert.equal(reason(undefined), 'Sign in on mini');
  assert.match(reason(['x'.repeat(200)]), /^Sign in on mini: x{60}$/);
});

test('an agent the Host is still checking says so, instead of telling the person to sign in', () => {
  const [row] = agentsOf([{ id: 'opencode', detected: true, signedIn: false, checking: true } as any], 'mini');
  assert.deepEqual([row.state, row.reason], ['signin', 'Checking on mini…']);
  const [signed] = agentsOf([{ id: 'opencode', detected: true, signedIn: true, checking: true } as any], 'mini');
  assert.equal(signed.reason, '');
});

test('the option fields a Host sends are validated: a long, alias or duplicate name, a default effort the model lacks or a non-boolean fast flag are dropped (#4935)', () => {
  const [agent] = agentsOf(
    [
      {
        id: 'claude',
        detected: true,
        signedIn: true,
        models: [
          {
            id: 'opus',
            name: 'Opus',
            default: false,
            efforts: ['low', 'high'],
            defaultEffort: 'high',
            resolvedModel: 'Opus 5.5',
            resolvedId: 'claude-opus-5-5',
            supportsFastMode: true,
          },
          {
            id: 'sonnet',
            name: 'Sonnet',
            default: false,
            efforts: ['low'],
            defaultEffort: 'high',
            resolvedModel: 'x'.repeat(61),
            supportsFastMode: 'yes',
          },
          { id: 'haiku', name: 'Haiku', default: false, efforts: [], resolvedModel: 'Haiku' },
          { id: 'fable', name: 'Fable', default: false, efforts: [], resolvedModel: 'fable', resolvedId: 7 },
          { id: 'opus', name: 'duplicate', default: false, efforts: [], resolvedModel: 'Opus 9' },
          { id: 'gpt-5.6', name: 'GPT-5.6', default: true, efforts: [], resolvedModel: 'GPT-5.6' },
        ],
      },
    ],
    'box',
  );
  assert.deepEqual(agent.models, [
    {
      id: 'opus',
      name: 'Opus',
      default: false,
      efforts: ['low', 'high'],
      defaultEffort: 'high',
      resolvedModel: 'Opus 5.5',
      resolvedId: 'claude-opus-5-5',
      supportsFastMode: true,
    },
    { id: 'sonnet', name: 'Sonnet', default: false, efforts: ['low'], defaultEffort: null },
    { id: 'haiku', name: 'Haiku', default: false, efforts: [], defaultEffort: null },
    { id: 'fable', name: 'Fable', default: false, efforts: [], defaultEffort: null },
    { id: 'gpt-5.6', name: 'GPT-5.6', default: true, efforts: [], defaultEffort: null, resolvedModel: 'GPT-5.6' },
  ]);
});

test('a Mac older than the fields drops none of its models for the extra keys, and a Host older than them leaves the fields absent (#4935)', () => {
  const [older] = agentsOf(
    [
      {
        id: 'claude',
        detected: true,
        signedIn: true,
        models: [{ id: 'opus', name: 'Opus', default: true, efforts: ['low'], future: { a: 1 }, resolvedModel: 7 }],
      },
    ],
    'box',
  );
  assert.deepEqual(older.models, [{ id: 'opus', name: 'Opus', default: true, efforts: ['low'], defaultEffort: null }]);
});

test('an agent whose sign-in the Host could not read in time stays usable and says so (#5177)', () => {
  const [a, b] = agentsOf(
    [
      { id: 'claude', detected: true, signedIn: false, unsure: true },
      { id: 'codex', detected: false, signedIn: false, unsure: true },
    ],
    'box',
  );
  assert.deepEqual([a.state, a.unsure, a.lent, a.reason], ['ready', true, undefined, 'Couldn’t check Claude Code on box']);
  assert.equal(b.state, 'missing', 'a missing agent is missing whatever the probe said');
});
