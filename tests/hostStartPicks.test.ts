// A new chat on a machine (desktop) or a computer (phone) starts on the agent, model and effort the last chat there used, while they are still offered; a pick made in the draft wins, and a stale memory falls back quietly.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { wantedHostAgent } from '../src/harness/hostAgent.ts';
import { hostModelSelection, machineModels } from '../shared/host/models.mjs';
import { loadPrefs } from '../src/store/types.ts';
import type { MachineAgent } from '../src/lib/hostMachines.ts';
import { forgetPicks, lastPick, rememberPick, rememberedHarness, rememberedModel } from '../mobile/src/remote/lastPicks.ts';

const agent = (id: string, state: MachineAgent['state']): MachineAgent => ({ id, label: id, state, reason: '' });

test('the agent asked for: the folder pick, then the draft harness, then the machine memory while ready, then the default', () => {
  const agents = [agent('claude', 'ready'), agent('codex', 'ready'), agent('kimi', 'signin')];
  const base = { draft: null, saved: 'codex' as const, agents };
  assert.equal(wantedHostAgent({ ...base, pick: 'kimi', draft: 'claude', remembered: 'claude' }), 'kimi');
  assert.equal(wantedHostAgent({ ...base, draft: 'acp:kimi', remembered: 'claude' }), 'kimi');
  assert.equal(wantedHostAgent({ ...base, remembered: 'claude' }), 'claude');
  // remembered but signed out, or gone from the machine: the saved default, without a "not ready" note
  assert.equal(wantedHostAgent({ ...base, remembered: 'kimi' }), 'codex');
  assert.equal(wantedHostAgent({ ...base, remembered: 'gemini' }), 'codex');
  assert.equal(wantedHostAgent({ ...base }), 'codex');
  // a machine that reports no readiness yet (an older Host, or its row not loaded): the memory stands, the machine refuses if it must
  assert.equal(wantedHostAgent({ ...base, agents: [], remembered: 'claude' }), 'claude');
  assert.equal(wantedHostAgent({ ...base, agents: [agent('claude', null)], remembered: 'claude' }), 'claude');
});

test("the machine's last model and effort start a new chat while it lists them; a stale one falls back, never unavailable", () => {
  const models = machineModels([
    { id: 'big', default: true, efforts: ['low', 'high'], defaultEffort: 'low' },
    { id: 'small', efforts: ['low', 'medium'], defaultEffort: 'medium' },
    { id: 'plain' },
  ]);
  const [big, small, plain] = models;
  assert.deepEqual(hostModelSelection(models, null, 'box', 'claude', null, { model: 'small', effort: 'low' }), {
    model: small,
    effort: 'low',
    unavailable: false,
  });
  // the effort that model no longer offers: the Mac's remembered one if offered, else the model's own
  assert.equal(hostModelSelection(models, null, 'box', 'claude', 'medium', { model: 'small', effort: 'max' }).effort, 'medium');
  assert.equal(hostModelSelection(models, null, 'box', 'claude', null, { model: 'small', effort: 'max' }).effort, 'medium');
  assert.equal(hostModelSelection(models, null, 'box', 'claude', null, { model: 'small', effort: null }).effort, 'medium');
  // a model gone from the machine: its default model, not "Model unavailable"
  assert.deepEqual(hostModelSelection(models, null, 'box', 'claude', null, { model: 'gone', effort: 'high' }), {
    model: big,
    effort: 'low',
    unavailable: false,
  });
  // an agent-only memory (the last chat took the agent's default model)
  assert.equal(hostModelSelection(models, null, 'box', 'claude', null, {}).model, big);
  assert.equal(hostModelSelection(models, null, 'box', 'claude', null, { model: 'plain', effort: 'high' }).model, plain);
  // the draft's own pick wins over the memory
  const pick = { hostId: 'box', harness: 'claude', model: 'big', effort: 'high' };
  assert.deepEqual(hostModelSelection(models, pick, 'box', 'claude', null, { model: 'small', effort: 'low' }), {
    model: big,
    effort: 'high',
    unavailable: false,
  });
});

test('saved per-machine picks keep only well-formed entries', () => {
  for (const bad of [undefined, null, 'x', ['a']]) assert.deepEqual(loadPrefs({ hostPicks: bad }).hostPicks, {});
  assert.deepEqual(
    loadPrefs({
      hostPicks: {
        box: { agent: 'claude', model: 'opus', effort: 'high' },
        mini: { agent: 'codex', model: '', effort: '' },
        old: { agent: 'kimi', model: 3, effort: null },
        none: { model: 'x' },
        empty: { agent: '' },
        nul: null,
        '': { agent: 'claude' },
      },
    }).hostPicks,
    { box: { agent: 'claude', model: 'opus', effort: 'high' }, mini: { agent: 'codex' }, old: { agent: 'kimi' } },
  );
  assert.deepEqual(loadPrefs(null).hostPicks, {});
});

beforeEach(() => forgetPicks());

test('the phone remembers the last start per pair and computer, until the account leaves', () => {
  assert.equal(lastPick('p', 'local'), null);
  rememberPick('p', 'local', { harness: 'claude', model: 'opus', effort: 'high' });
  rememberPick('p', 'h1', { harness: 'codex', model: null, effort: null });
  rememberPick(null, 'local', { harness: 'kimi', model: null, effort: null });
  assert.deepEqual(lastPick('p', 'local'), { harness: 'claude', model: 'opus', effort: 'high' });
  assert.equal(lastPick('p', 'h1')?.harness, 'codex');
  assert.equal(lastPick(null, 'local')?.harness, 'kimi');
  assert.equal(lastPick('q', 'local'), null);
  forgetPicks();
  assert.equal(lastPick('p', 'local'), null);
});

test("the phone's remembered agent counts while it is listed ready; its model and effort while the options offer them", () => {
  const pick = { harness: 'claude', model: 'opus', effort: 'high' };
  assert.equal(rememberedHarness(pick, [{ id: 'codex' }, { id: 'claude' }]), 'claude');
  assert.equal(rememberedHarness(pick, [{ id: 'claude', unavailable: true }]), null);
  assert.equal(rememberedHarness(null, [{ id: 'claude' }]), null);
  const models = [
    { id: 'opus', efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' },
    { id: 'plain', efforts: [] },
  ];
  const loaded = { model: 'opus', effort: 'low' };
  assert.deepEqual(rememberedModel(pick, 'claude', models, loaded), { model: 'opus', effort: 'high' });
  assert.equal(rememberedModel(pick, 'codex', models, loaded), null);
  assert.equal(rememberedModel(null, 'claude', models, loaded), null);
  assert.equal(rememberedModel({ ...pick, model: null }, 'claude', models, loaded), null);
  assert.equal(rememberedModel({ ...pick, model: 'gone' }, 'claude', models, loaded), null);
  // an effort the model no longer offers: the one the options chose for it, else the model's own default, else none
  assert.deepEqual(rememberedModel({ ...pick, effort: 'max' }, 'claude', models, loaded), { model: 'opus', effort: 'low' });
  assert.deepEqual(rememberedModel({ ...pick, effort: 'max' }, 'claude', models, { model: 'other', effort: 'high' }), {
    model: 'opus',
    effort: 'low',
  });
  assert.deepEqual(rememberedModel({ ...pick, effort: null }, 'claude', models, { model: 'opus', effort: 'max' }), {
    model: 'opus',
    effort: 'low',
  });
  assert.deepEqual(rememberedModel({ ...pick, model: 'plain' }, 'claude', models, loaded), { model: 'plain', effort: null });
});
