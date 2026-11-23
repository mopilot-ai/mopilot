// src/components/momo/brainEffort.ts (#2139): the effort MoMo's brain chip offers. On Codex and Claude Code: the brain's
// model's levels (its harness's default model when it names none), the brain's effort where the model has it, else the
// model's default, and a pick goes to main. On a basic harness: its open session's thought level, set on that session only.
// None with fewer than two levels, and none before the brain is read.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { render, flush } from './support/shell-chrome-kit.ts';

const models: Record<string, any[]> = {
  claude: [
    { id: 'opus', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
    { id: 'haiku', efforts: [], defaultEffort: null },
  ],
  codex: [{ id: 'gpt-5', efforts: ['low', 'medium'], defaultEffort: 'medium', isDefault: true }],
};
let options: any[] = [];
let live = true;
const asked: any[] = [];
const chosen: any[] = [];
mock.module('../src/session/harness/select.ts', { namedExports: { useHarnessModels: (hh: string) => models[hh] } });
mock.module('../src/session/acpControls.ts', {
  namedExports: {
    useBasicSelection: (chatId: any, basic: string) => (asked.push([chatId, basic]), { options, live }),
  },
});
mock.module('../src/session/harness/acp.ts', {
  namedExports: {
    optionValues: (o: any) => o.options,
    setAcpConfig: async (...a: any[]) => {
      chosen.push(a);
      return true;
    },
  },
});

const { useBrainEffort } = await import('../src/components/momo/brainEffort.ts');

/** The hook's answer for a brain, read through a component that renders it. */
async function effortOf(
  brain: any,
  hh: string | null,
  chatId: string | null = 'momo-chat',
  set: (b: any, e: string) => unknown = () => undefined,
) {
  let out: any;
  const Probe = () => {
    out = useBrainEffort(brain, hh as any, chatId, set);
    return null;
  };
  const r = await render(h(Probe));
  await flush();
  await r.unmount();
  return out;
}

const brain = (harness: string, model: string | null, effort: string | null) => ({
  harness,
  account: null,
  model,
  modelLabel: null,
  effort,
});

test('first-tier: the model’s levels with the brain’s effort, else its default; a pick goes to main', async () => {
  const sets: string[] = [];
  const e = await effortOf(brain('claude', 'opus', 'max'), 'claude', 'momo-chat', (b, x) => sets.push(`${b.model}:${x}`));
  assert.deepEqual([e.efforts, e.effort, e.defaultEffort], [['low', 'high', 'max'], 'max', 'high']);
  e.pick('low');
  assert.deepEqual(sets, ['opus:low']);
  assert.equal((await effortOf(brain('claude', 'opus', 'xhigh'), 'claude')).effort, 'high');
  assert.equal((await effortOf(brain('claude', 'opus', null), 'claude')).effort, 'high');
  // no model named: the harness's default one
  assert.deepEqual((await effortOf(brain('codex', null, 'low'), 'codex')).efforts, ['low', 'medium']);
  // no levels, or a model not listed: nothing to show
  assert.equal(await effortOf(brain('claude', 'haiku', null), 'claude'), null);
  assert.equal(await effortOf(brain('claude', 'gone', null), 'claude'), null);
  // a first-tier brain asks no basic harness for its session
  assert.deepEqual(asked.at(-1), [null, '']);
});

test('a basic harness: its session’s thought level, by its own names, set on the session', async () => {
  options = [
    { id: 'model', category: 'model', type: 'select', options: [{ value: 'k2', name: 'K2' }] },
    {
      id: 'think',
      category: 'thought_level',
      type: 'select',
      currentValue: 2,
      options: [
        { value: 1, name: 'Quick' },
        { value: 2, name: 'Deep' },
      ],
    },
  ];
  const e = await effortOf(brain('acp:kimi', null, null), null);
  assert.deepEqual(asked.at(-1), ['momo-chat', 'kimi']);
  assert.deepEqual([e.efforts, e.effort, e.defaultEffort], [['1', '2'], '2', null]);
  assert.equal(e.labelOf('1'), 'Quick');
  // a value the harness doesn't list goes by its id
  assert.equal(e.labelOf('9'), '9');
  e.pick('1');
  assert.deepEqual(chosen.at(-1), ['momo-chat', 'think', 1]);
  // a session not open yet (or no chat): its options are the catalog's, nothing of MoMo's to set
  live = false;
  assert.equal(await effortOf(brain('acp:kimi', null, null), null), null);
  live = true;
  assert.equal(await effortOf(brain('acp:kimi', null, null), null, null), null);
  // none picked yet
  options[1] = { ...options[1], currentValue: null };
  assert.equal((await effortOf(brain('acp:kimi', null, null), null)).effort, null);
  // one level, or none: nothing to show
  options[1] = { ...options[1], options: [{ value: 1, name: 'Quick' }] };
  assert.equal(await effortOf(brain('acp:kimi', null, null), null), null);
  options = [options[0]];
  assert.equal(await effortOf(brain('acp:kimi', null, null), null), null);
});

test('before the brain is read there is nothing to show', async () => {
  assert.equal(await effortOf(null, null), null);
});
