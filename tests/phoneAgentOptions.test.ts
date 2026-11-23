// An agent's model options on the phone (#4935): the Mac's phone machine row carries each agent's models, the phone's reader keeps them, a machine chat's controls hold them in the options shape, and a model is named by the model it resolves to; a Mac or Host that sends none leaves them absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import './support/phone/register.ts';
const clientPath = '../mobile/src/remote/client';
const machinesPath = '../mobile/src/remote/machines';
const controlsPath = '../mobile/src/remote/hostControls';
const { readOptions } = await import(clientPath);
const { parseMachines } = await import(machinesPath);
const { hostControls, hostModelOption } = await import(controlsPath);
const { phoneMachine } = createRequire(import.meta.url)('../electron/remote/phoneMachines.cjs');

const OPUS = {
  id: 'opus',
  name: 'Opus',
  default: false,
  efforts: ['low', 'high'],
  defaultEffort: 'high',
  resolvedModel: 'Opus 5.5',
  resolvedId: 'claude-opus-5-5',
  supportsFastMode: true,
};
const PLAIN = { id: 'plain', name: 'Plain', default: true, efforts: [], defaultEffort: null };

test("the phone machine row carries each agent's models, validated, and none for an agent or Host that reports none", () => {
  const row = {
    id: 'h1',
    name: 'Studio',
    status: 'online',
    agents: [
      { id: 'claude', label: 'Claude Code', state: 'ready', models: [OPUS, { id: 'x', name: 'X', resolvedModel: 'x'.repeat(90) }] },
      { id: 'codex', label: 'Codex', state: 'ready', models: [] },
      { id: 'kimi', label: 'Kimi', state: 'ready' },
    ],
  };
  const [claude, codex, kimi] = phoneMachine(row, null, { now: 0, orgCovers: () => false }).agents;
  assert.deepEqual(
    claude.models.map((m: any) => [m.id, m.resolvedModel]),
    [
      ['opus', 'Opus 5.5'],
      ['x', undefined],
    ],
  );
  assert.equal('models' in codex, false);
  assert.equal('models' in kimi, false);
});

test('the phone reads the models of an agent, and an older Mac leaves them absent', () => {
  const read = parseMachines({
    machines: [
      {
        id: 'h1',
        line: 'Online',
        agents: [{ id: 'claude', state: 'ready', models: [OPUS, 'junk'] }, { id: 'codex', state: 'ready', models: [] }, { id: 'kimi' }],
      },
    ],
  });
  const [claude, codex, kimi] = read[0].agents;
  assert.equal(claude.models[0].resolvedModel, 'Opus 5.5');
  assert.equal(claude.models.length, 1);
  assert.equal('models' in codex, false);
  assert.equal('models' in kimi, false);
});

test("a machine chat's controls hold each agent's models in the options shape, named by the model they resolve to; the sheets' own list stays as it was", () => {
  const agents = [
    { id: 'claude', label: 'Claude Code', state: 'ready', reason: '', models: [OPUS, PLAIN] },
    { id: 'kimi', label: 'Kimi', state: 'ready', reason: '' },
  ];
  const controls = hostControls({
    machineName: 'Studio',
    agents: agents as never,
    current: 'claude',
    pending: undefined,
    permission: undefined,
  });
  assert.deepEqual(controls.models, []);
  assert.deepEqual(controls.machine.agents[0].models, [
    {
      id: 'opus',
      label: 'Opus 5.5',
      resolvedModel: 'Opus 5.5',
      efforts: [
        { id: 'low', label: 'low' },
        { id: 'high', label: 'high' },
      ],
      defaultEffort: 'high',
      fast: { supported: true },
    },
    { id: 'plain', label: 'Plain', efforts: [], defaultEffort: null, default: true },
  ]);
  assert.equal('models' in controls.machine.agents[1], false);
  assert.equal(hostModelOption({ ...PLAIN, description: 'Fast one', supportsFastMode: false }).fast?.supported, false);
  assert.equal(hostModelOption({ ...PLAIN, description: 'Fast one' }).description, 'Fast one');
});

test('options.get models are labelled by the resolved name over the label, and by the label when none is sent', () => {
  const read = readOptions(
    {
      models: [
        { id: 'a', label: 'Opus', resolvedModel: 'Opus 5.5', efforts: [] },
        { id: 'b', label: 'Haiku', efforts: [] },
        { id: 'c', efforts: [] },
      ],
      permission: { rows: [] },
    },
    'default',
  );
  assert.deepEqual(
    read.models.map((m: any) => m.label),
    ['Opus 5.5', 'Haiku', 'c'],
  );
});
