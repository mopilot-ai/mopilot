// SquillaRouter's model policy, asset lookup, runtime assembly and the main-process router's load/timeout/unload lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const policy = require('../electron/autoRoute/squilla/policy.cjs');
const assets = require('../electron/autoRoute/squilla/assets.cjs');
const { createSquillaRouter, loadRuntime, routerInput, IDLE_MS, TIMEOUT_MS } = require('../electron/autoRoute/squilla/router.cjs');

const noFlags = { debug: false, high_risk: false, long_context: false, strict_format: false, repo_arch: false };

test('policy: flags follow router.runtime.yaml keyword, pattern and size rules', () => {
  assert.deepEqual(policy.flagsFor('hello', 0), noFlags);
  const f = policy.flagsFor('Deploy the JSON schema; refactor the codebase. FAILED', 0);
  assert.deepEqual([f.high_risk, f.strict_format, f.repo_arch, f.debug, f.long_context], [true, true, true, true, false]);
  assert.equal(policy.flagsFor('stderr: boom', 0).debug, true);
  assert.equal(policy.flagsFor('x'.repeat(6000), 0).long_context, true);
  assert.equal(policy.flagsFor('```' + 'c'.repeat(1500) + '```', 0).long_context, true);
  assert.equal(policy.flagsFor('[INFO] a\n'.repeat(200), 0).long_context, true);
  assert.equal(policy.flagsFor('see a/b.ts and c/d.ts', 0).long_context, true);
  assert.equal(policy.flagsFor('short', 2001).long_context, true);
  assert.equal(policy.flagsFor('short', 2000).long_context, false);
});

test('policy: thinking mode, margin and difficulty follow controller.py', () => {
  assert.equal(policy.marginOf([0.125, 0.75, 0.125]), 0.625);
  assert.ok(Math.abs(policy.difficultyOf([0, 0.5, 0.5, 0]) - 1.5) < 1e-12);
  assert.equal(policy.thinkingFor('C3', [0, 0, 0, 1], noFlags, 'x'), 'T3');
  assert.equal(policy.thinkingFor('C2', [0, 0, 1, 0], { ...noFlags, debug: true }, 'x'), 'T3');
  assert.equal(policy.thinkingFor('C2', [0, 0, 1, 0], noFlags, 'x'), 'T2');
  assert.equal(policy.thinkingFor('C1', [0, 0.9, 0.1, 0], { ...noFlags, high_risk: true }, 'x'), 'T1', 'deep flags need tier C2');
  assert.equal(policy.thinkingFor('C0', [0.8, 0.2, 0, 0], noFlags, 'x'), 'T0');
  assert.equal(policy.thinkingFor('C0', [0.7, 0.25, 0.05, 0], noFlags, 'x'), 'T1');
  assert.equal(policy.thinkingFor('C1', [0.3, 0.4, 0.3, 0], noFlags, 'x'), 'T2');
  assert.equal(policy.thinkingFor('C1', null, noFlags, 'x'), 'T2', 'no tier vector means no margin');
  assert.equal(policy.thinkingFor('C0', null, noFlags, '  Thanks!! '), 'T0', 'a trivial acknowledgement on C0');
  assert.equal(policy.thinkingFor('C1', null, noFlags, 'thanks'), 'T2');
  assert.equal(policy.thinkingFor('C2', [0, 0, 1, 0], { ...noFlags, long_context: true }, 'x'), 'T3');
  assert.equal(policy.thresholdIntent({ new_task: 0.2, continue: 0.5, redo: 0.3 }), 'redo');
  assert.equal(policy.thresholdIntent({ new_task: 0.4, continue: 0.3, redo: 0.3 }), 'new_task');
  assert.equal(policy.thresholdIntent({ new_task: 0.005, continue: 0.99, redo: 0.005 }), 'continue');
  assert.equal(policy.thresholdIntent({ new_task: 0.05, continue: 0.9, redo: 0.05 }), 'new_task', 'p_new at 1% already starts a task');
});

function predictor(intentProbs: any, tierProbs = [0.1, 0.2, 0.6, 0.1]) {
  const calls: boolean[] = [];
  const predict = async (withIntent: boolean) => {
    calls.push(withIntent);
    return { intentProbs: withIntent ? intentProbs : null, tierProbs };
  };
  return { calls, predict };
}

test('policy: decide runs only the heads each intent needs and keeps or raises the active tier', async () => {
  const fresh = predictor(null);
  const first = await policy.decide({ text: 'fix the bug', activeTier: null, contextTokens: 0, predict: fresh.predict });
  assert.deepEqual([first.intent, first.tier, first.thinking, fresh.calls], ['new_task', 'C2', 'T3', [false]]);
  assert.equal(first.reason, 'no active task; tier head chose C2');
  assert.ok(Math.abs(first.difficulty - 1.7) < 1e-12);
  assert.ok(Math.abs(first.margin - 0.4) < 1e-12);
  assert.deepEqual(first.flags, { debug: true, high_risk: false, long_context: false, strict_format: false });

  const cont = predictor({ new_task: 0.001, continue: 0.99, redo: 0.009 });
  const kept = await policy.decide({ text: 'go on', activeTier: 'C1', contextTokens: 0, predict: cont.predict });
  assert.deepEqual([kept.intent, kept.tier, kept.thinking, kept.difficulty, kept.margin], ['continue', 'C1', 'T2', null, null]);
  assert.match(kept.reason, /continuation; keeps C1/);
  assert.deepEqual(kept.tierProbs, [0.1, 0.2, 0.6, 0.1], 'the tier head ran with the intent head');

  const redo = predictor({ new_task: 0.001, continue: 0.3, redo: 0.699 });
  const raised = await policy.decide({ text: 'wrong, redo', activeTier: 'C3', contextTokens: 0, predict: redo.predict });
  assert.deepEqual([raised.intent, raised.tier, raised.thinking], ['redo', 'C3', 'T3'], 'redo is capped at C3');
  assert.match(raised.reason, /correction; one tier above C3/);

  const fresh2 = predictor({ new_task: 0.9, continue: 0.05, redo: 0.05 }, [0.7, 0.2, 0.1, 0]);
  const newTask = await policy.decide({ text: 'new topic', activeTier: 'C2', contextTokens: 0, predict: fresh2.predict });
  assert.deepEqual([newTask.intent, newTask.tier, newTask.thinking, fresh2.calls], ['new_task', 'C0', 'T0', [true]]);
  assert.match(newTask.reason, /new task; tier head chose C0/);

  const explicitRedo = predictor(null);
  const up = await policy.decide({ text: 'x', activeTier: 'C0', contextTokens: 0, explicitControl: 'redo', predict: explicitRedo.predict });
  assert.deepEqual([up.intent, up.tier, explicitRedo.calls, up.reason], ['redo', 'C1', [], 'explicit redo; one tier above C0']);
  const lonelyRedo = predictor(null);
  const restart = await policy.decide({
    text: 'x',
    activeTier: null,
    contextTokens: 0,
    explicitControl: 'redo',
    predict: lonelyRedo.predict,
  });
  assert.deepEqual([restart.intent, lonelyRedo.calls], ['new_task', [false]]);
  assert.match(restart.reason, /^redo without an active task/);
  const explicitNew = predictor(null);
  const reset = await policy.decide({
    text: 'x',
    activeTier: 'C3',
    contextTokens: 0,
    explicitControl: 'new_task',
    predict: explicitNew.predict,
  });
  assert.deepEqual([reset.intent, reset.tier, explicitNew.calls, reset.intentProbs], ['new_task', 'C2', [false], null]);
  assert.match(reset.reason, /^explicit new task/);
  const bogus = predictor(null);
  const unknownTier = await policy.decide({ text: 'x', activeTier: 'C9', contextTokens: 0, predict: bogus.predict });
  assert.equal(unknownTier.reason, 'no active task; tier head chose C2', 'an unknown active tier counts as none');
});

test('assets: candidate folders, size-verified lookup and the converted parameters', () => {
  assert.deepEqual(assets.candidateDirs({ assetsDir: '/x' }), ['/x']);
  assert.deepEqual(assets.candidateDirs({ resourcesPath: '/r', appRoot: '/a', userData: '/u' }), [
    path.join('/r', 'auto-route', 'squilla'),
    path.join('/a', 'build', 'vendor', 'auto-route', 'squilla'),
    path.join('/u', 'auto-route', 'squilla'),
  ]);
  assert.deepEqual(assets.candidateDirs({}), []);
  const sizes = new Map(assets.UPSTREAM.files.map((f: any) => [path.join('/good', f.name), f.size]));
  const fsx = {
    statSync: (p: string) => {
      if (p.startsWith('/bad')) return { size: 1 };
      if (!sizes.has(p)) throw new Error('ENOENT');
      return { size: sizes.get(p) };
    },
  };
  assert.equal(assets.findAssetsDir(['/missing', '/bad', '/good'], fsx), '/good');
  assert.equal(assets.findAssetsDir(['/missing'], fsx), null);
  const params = assets.loadParams();
  assert.equal(params.tfidf.vocabulary.length, 10000);
  assert.equal(params.svd.components.length, 100 * 10000);
  assert.deepEqual([params.pca.rows, params.pca.mean.length, params.pca.whiten], [64, 512, false]);
  assert.equal(params.scaler.mean.length, 88);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-route-params-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(4));
    assert.throws(() => assets.readArray({ file: 'a.bin', dtype: '<i4', shape: [1] }, dir), /unsupported parameter dtype/);
    assert.throws(() => assets.readArray({ file: 'a.bin', dtype: '<f8', shape: [1] }, dir), /has 4 bytes/);
    assert.deepEqual(Array.from(assets.readArray({ file: 'a.bin', dtype: '<f4', shape: [1] }, dir)), [0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assets: the upstream loader checks the tier model size and reads the tokenizer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-route-upstream-'));
  try {
    fs.mkdirSync(path.join(dir, 'tier'));
    fs.mkdirSync(path.join(dir, 'bge'));
    fs.writeFileSync(path.join(dir, 'bge/tokenizer.json'), '{"model":{}}');
    fs.writeFileSync(path.join(dir, 'tier/model.txt.gz'), zlib.gzipSync('tree\n'));
    assert.throws(() => assets.loadUpstream(dir), /pinned size/);
    const size = assets.UPSTREAM.files.find((f: any) => f.name === 'tier/model.txt.gz').gunzippedSize;
    fs.writeFileSync(path.join(dir, 'tier/model.txt.gz'), zlib.gzipSync(Buffer.alloc(size, 32)));
    const up = assets.loadUpstream(dir);
    assert.equal(up.tierModel.length, size);
    assert.deepEqual(up.tokenizer, { model: {} });
    assert.equal(up.bgeModel, path.join(dir, 'bge/model.onnx'));
    assert.equal(up.intentModel, path.join(dir, 'intent/model.int8.onnx'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const TOKENIZER = {
  normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: false },
  pre_tokenizer: { type: 'BertPreTokenizer' },
  model: { type: 'WordPiece', unk_token: '[UNK]', vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, fix: 4 } },
};
const stump = (i: number, v: number) =>
  `Tree=${i}\nnum_leaves=1\nnum_cat=0\nsplit_feature=\nthreshold=\ndecision_type=\nleft_child=\nright_child=\nleaf_value=${v}\n`;
const TIER_MODEL = `tree\nnum_class=4\nnum_tree_per_iteration=4\nmax_feature_idx=379\nobjective=multiclass num_class:4\n\n${[0, 0, 2, 0].map((v, i) => stump(i, v)).join('\n')}end of trees\n`;

function fakeOrt() {
  const released: string[] = [];
  class Tensor {
    type: string;
    data: any;
    dims: number[];
    constructor(type: string, data: any, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const session = (name: string) => ({
    inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
    outputNames: [name === 'bge' ? 'h' : 'logits'],
    run: async () =>
      name === 'bge'
        ? { h: { dims: [1, 512, 512], data: new Float32Array(512 * 512).fill(1) } }
        : { logits: { dims: [1, 3], data: Float32Array.of(0, 5, 0) } },
    release: async () => void released.push(name),
  });
  return { released, ort: { Tensor, InferenceSession: { create: async (p: string) => session(p) } } };
}

test('loadRuntime wires tokenizer, encoders, featurizer, tier head and intent head', async () => {
  const f = fakeOrt();
  const runtime = await loadRuntime({
    dir: '/assets',
    ort: f.ort,
    arch: 'x64',
    readUpstream: (dir: string) => ({ bgeModel: 'bge', intentModel: 'intent', tokenizer: TOKENIZER, tierModel: TIER_MODEL, dir }),
  });
  const input = routerInput({ currentRequest: 'fix', activeTier: 'C1', historyUser: ['a'], previousAnswer: 'b' });
  const tierOnly = await runtime.predict(input, false);
  assert.equal(tierOnly.intentProbs, null);
  assert.equal(tierOnly.features.length, 380);
  assert.equal(tierOnly.tierProbs.indexOf(Math.max(...tierOnly.tierProbs)), 2);
  const both = await runtime.predict(input, true);
  assert.ok(both.intentProbs.continue > 0.9);
  assert.deepEqual(Object.keys(both.intentProbs), ['new_task', 'continue', 'redo']);
  assert.equal(both.numeric.length, 88);
  assert.equal(runtime.tokenizer.clsId, 2);
  await runtime.close();
  assert.deepEqual(f.released.sort(), ['bge', 'intent']);
});

test('routerInput caps history like decide_model_tier and keeps only a usable context estimate', () => {
  const r = routerInput({
    currentRequest: 'x',
    historyUser: ['1', '2', '3', '4', '5'],
    routeHistory: [1, 2, 3, 4, 5, 6].map((i) => ({ tier: `C${i % 4}` })),
    contextTokensEst: 12,
  });
  assert.deepEqual(r.history_user, ['2', '3', '4', '5']);
  assert.equal(r.route_history.length, 5);
  assert.deepEqual(r.context, { context_tokens_est: 12 });
  assert.deepEqual(routerInput({ currentRequest: 'x', contextTokensEst: 1.5 }).context, {});
  assert.deepEqual(routerInput({ currentRequest: 'x', contextTokensEst: -1 }).context, {});
  assert.deepEqual(routerInput({ currentRequest: 'x' }), {
    current_request: 'x',
    history_user: [],
    previous_answer: '',
    previous_usage: {},
    route_history: [],
    active_route_tier: null,
    context: {},
  });
});

function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id as any;
    },
    clearTimeout: (id: any) => void pending.delete(id),
    fire(ms: number) {
      for (const [id, t] of [...pending])
        if (t.ms === ms) {
          pending.delete(id);
          t.fn();
        }
    },
  };
}

function fakeRuntime(over: Record<string, any> = {}) {
  const r = {
    closed: 0,
    inputs: [] as any[],
    predict: async (input: any, withIntent: boolean) => {
      r.inputs.push({ input, withIntent });
      return { intentProbs: withIntent ? { new_task: 0, continue: 1, redo: 0 } : null, tierProbs: [0.9, 0.1, 0, 0] };
    },
    close: async () => {
      r.closed++;
    },
    ...over,
  };
  return r;
}

test('router: routes through the policy, reports availability and unloads after the idle period', async () => {
  const timers = fakeTimers();
  const runtimes: any[] = [];
  const loads: any[] = [];
  const router = createSquillaRouter({
    assetsDir: '/a',
    findDir: (dirs: string[]) => (dirs[0] === '/a' ? '/a' : null),
    loadOrt: () => 'ort',
    arch: 'arm64',
    timers,
    load: async (o: any) => {
      loads.push(o);
      const r = fakeRuntime();
      runtimes.push(r);
      return r;
    },
  });
  assert.equal(await router.available(), true);
  const first = await router.route({ currentRequest: 'thanks', contextTokensEst: 3000 });
  assert.deepEqual([first.intent, first.tier, first.thinking, first.flags.long_context], ['new_task', 'C0', 'T0', true]);
  assert.deepEqual(loads, [{ dir: '/a', ort: 'ort', arch: 'arm64' }]);
  const second = await router.route({ currentRequest: 'go on', activeTier: 'C2' });
  assert.deepEqual([second.intent, second.tier], ['continue', 'C2']);
  assert.equal(loads.length, 1, 'the loaded runtime is reused');
  assert.deepEqual(runtimes[0].inputs.map((i: any) => i.withIntent).slice(0, 2), [false, true]);
  await Promise.all([router.route({ currentRequest: 'a' }), router.route({ currentRequest: 'b' })]);
  assert.equal(
    [...timers.pending.values()].filter((t) => t.ms === IDLE_MS).length,
    1,
    'one idle timer at a time, even after overlapping turns',
  );
  timers.fire(IDLE_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(runtimes[0].closed, 1);
  await router.route({ currentRequest: 'again' });
  assert.equal(loads.length, 2, 'a route after unloading loads again');
  router.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(runtimes[1].closed, 1);
  assert.equal(await router.available(), false);
  await assert.rejects(router.route({ currentRequest: 'x' }), /closed/);
  router.close();
});

test('router: missing assets, missing ONNX Runtime, failed loads, timeouts and failed releases', async () => {
  const none = createSquillaRouter({ resourcesPath: undefined, appRoot: undefined, findDir: () => null, timeoutMs: 50 });
  assert.equal(await none.available(), false);
  await assert.rejects(none.route({ currentRequest: 'x' }), /not installed/);
  none.close();

  const realOrt = createSquillaRouter({ findDir: () => '/a' });
  assert.equal(await realOrt.available(), true, 'onnxruntime-node loads on the platforms CI runs');
  realOrt.close();

  const noOrt = createSquillaRouter({
    findDir: () => '/a',
    loadOrt: () => {
      throw new Error('no build for darwin/x64');
    },
  });
  assert.equal(await noOrt.available(), false);
  noOrt.close();

  let attempts = 0;
  const flaky = createSquillaRouter({
    findDir: () => '/a',
    loadOrt: () => 'ort',
    load: async () => {
      attempts++;
      if (attempts === 1) throw new Error('corrupt model');
      return fakeRuntime({ close: async () => Promise.reject(new Error('release failed')) });
    },
  });
  await assert.rejects(flaky.route({ currentRequest: 'x' }), /corrupt model/);
  const ok = await flaky.route({ currentRequest: 'x' });
  assert.equal(ok.tier, 'C0', 'the next turn retries the load');
  flaky.close();
  await new Promise((r) => setImmediate(r));

  const timers = fakeTimers();
  const slow = createSquillaRouter({
    findDir: () => '/a',
    loadOrt: () => 'ort',
    timers,
    load: () => new Promise(() => {}),
  });
  const first = slow.route({ currentRequest: 'x' });
  await new Promise((r) => setImmediate(r));
  timers.fire(TIMEOUT_MS);
  await assert.rejects(first, /longer than/);
  assert.equal([...timers.pending.values()].filter((t) => t.ms === IDLE_MS).length, 1);
  const pending = slow.route({ currentRequest: 'x' });
  assert.equal([...timers.pending.values()].filter((t) => t.ms === IDLE_MS).length, 0, 'no idle unload while a turn runs');
  await new Promise((r) => setImmediate(r));
  timers.fire(TIMEOUT_MS);
  await assert.rejects(pending, new RegExp(`longer than ${TIMEOUT_MS} ms`));
  slow.close();

  const realTimers = createSquillaRouter({
    findDir: () => '/a',
    loadOrt: () => 'ort',
    load: async () => fakeRuntime({ predict: async () => Promise.reject(new Error('inference failed')) }),
  });
  await assert.rejects(realTimers.route({ currentRequest: 'x' }), /inference failed/);
  realTimers.close();
});
