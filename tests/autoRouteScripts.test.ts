// Auto routing's build scripts: the verified weight fetch, the packaging rules for ONNX Runtime, and the parity checker.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { recorder, runScript, tempDir } from './support/scripts-shared-cli.ts';

const require = createRequire(import.meta.url);
const fetchScript = await import('../scripts/fetch-auto-route-assets.mjs');
const { autoRoutePackaging } = await import('../scripts/auto-route/packaging.mjs');
const parity = await import('../scripts/auto-route/parity.mjs');
const lgb = require('../electron/autoRoute/squilla/lightgbm.cjs');

const made: string[] = [];
const scratch = (prefix: string) => {
  const dir = tempDir(prefix);
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
const PLAIN = Buffer.from('plain bytes');
const TEXT = Buffer.from('gunzipped contents');
const GZ = zlib.gzipSync(TEXT);
const upstream = {
  repository: 'owner/repo',
  commit: 'abc',
  files: [
    { name: 'dir/plain.bin', path: 'src/plain.bin', lfs: true, size: PLAIN.length, sha256: sha(PLAIN) },
    {
      name: 'model.txt.gz',
      path: 'model.txt.gz',
      lfs: false,
      size: GZ.length,
      sha256: sha(GZ),
      gunzippedSize: TEXT.length,
      gunzippedSha256: sha(TEXT),
    },
  ],
};
const served = (bodies: Record<string, Buffer>, status = 200) =>
  recorder(async (url: string) => ({
    ok: status === 200 && url in bodies,
    status: url in bodies ? status : 404,
    arrayBuffer: async () => bodies[url],
  }));

test('fetch: pinned URLs, verified downloads, reuse of verified files and replacement of bad ones', async () => {
  assert.equal(fetchScript.fileUrl(upstream.files[0], upstream), 'https://media.githubusercontent.com/media/owner/repo/abc/src/plain.bin');
  assert.equal(fetchScript.fileUrl(upstream.files[1], upstream), 'https://raw.githubusercontent.com/owner/repo/abc/model.txt.gz');
  assert.match(fetchScript.fileUrl(fetchScript.UPSTREAM.files[0]), /TokenRhythm\/opensquilla\/96ad3e4/);
  const out = tempDir('auto-route-fetch-');
  try {
    const fetchImpl = served({
      [fetchScript.fileUrl(upstream.files[0], upstream)]: PLAIN,
      [fetchScript.fileUrl(upstream.files[1], upstream)]: GZ,
    });
    const log = recorder();
    assert.equal(await fetchScript.fetchAssets({ out, fetchImpl, log, upstream }), out);
    assert.deepEqual(fs.readFileSync(path.join(out, 'dir/plain.bin')), PLAIN);
    assert.equal(log.calls.length, 2);
    assert.equal(fetchScript.complete(out, upstream), true);
    await fetchScript.fetchAssets({ out, fetchImpl, log, upstream });
    assert.equal(fetchImpl.calls.length, 2, 'verified files are not downloaded again');
    fs.writeFileSync(path.join(out, 'dir/plain.bin'), 'tampered');
    assert.equal(fetchScript.complete(out, upstream), false);
    await fetchScript.fetchAssets({ out, fetchImpl, log, upstream });
    assert.deepEqual(fs.readFileSync(path.join(out, 'dir/plain.bin')), PLAIN, 'a bad file is replaced');
    assert.equal(fetchScript.complete(scratch('auto-route-empty-'), upstream), false);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('fetch: copies from a local folder and refuses wrong sizes, hashes, gzip contents and HTTP errors', async () => {
  const from = tempDir('auto-route-from-');
  const out = tempDir('auto-route-out-');
  try {
    fs.mkdirSync(path.join(from, 'dir'));
    fs.writeFileSync(path.join(from, 'dir/plain.bin'), PLAIN);
    fs.writeFileSync(path.join(from, 'model.txt.gz'), GZ);
    await fetchScript.fetchAssets({ out, from, log: () => {}, upstream });
    assert.equal(fetchScript.complete(out, upstream), true);
    await assert.rejects(
      fetchScript.fetchAssets({ out: scratch('auto-route-x-'), from: scratch('auto-route-none-'), upstream }),
      /dir\/plain\.bin is not in/,
    );
    await assert.rejects(fetchScript.fetchAssets({ out: scratch('auto-route-y-'), fetchImpl: served({}, 500), upstream }), /HTTP 404/);
    const file = upstream.files[1];
    assert.throws(() => fetchScript.verify(file, Buffer.from('short')), /bytes, expected/);
    assert.throws(() => fetchScript.verify({ ...file, sha256: '0' }, GZ), /SHA-256/);
    assert.throws(() => fetchScript.verify({ ...file, gunzippedSize: 1 }, GZ), /gunzipped contents/);
    assert.throws(() => fetchScript.verify({ ...file, gunzippedSha256: '0' }, GZ), /gunzipped contents/);
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('fetch: the command line reports success or the failure and its exit code', async () => {
  const run = recorder(async (o: any) => o.out);
  const log = recorder();
  assert.equal(await fetchScript.main(['--out', 'rel/dir', '--from', '/src'], { fetch: run, log }), 0);
  assert.deepEqual(run.calls[0][0].out, path.resolve('rel/dir'));
  assert.equal(run.calls[0][0].from, '/src');
  assert.match(log.calls.at(-1)?.[0], /ready in/);
  await fetchScript.main([], { fetch: run, log });
  assert.equal(run.calls[1][0].out, fetchScript.DEFAULT_OUT);
  const error = recorder();
  assert.equal(await fetchScript.main([], { fetch: async () => Promise.reject(new Error('offline')), error }), 1);
  assert.deepEqual(error.calls, [['offline']]);
  const empty = tempDir('auto-route-cli-');
  try {
    const r = runScript('scripts/fetch-auto-route-assets.mjs', ['--out', path.join(empty, 'out'), '--from', empty]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bge\/model\.onnx is not in/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('packaging: fetches into build/vendor/auto-route and keeps only this build’s ONNX Runtime', async () => {
  const fetch = recorder(async () => {});
  const mac = await autoRoutePackaging({ platform: 'darwin', arch: 'arm64', fetch });
  assert.equal(mac.resource, path.resolve('build/vendor/auto-route'));
  assert.deepEqual(fetch.calls[0], [{ out: path.resolve('build/vendor/auto-route/squilla') }]);
  const dropped = (o: any, p: string) => o.ignore.some((r: RegExp) => r.test(p));
  const bin = '/node_modules/onnxruntime-node/bin/napi-v6';
  assert.equal(dropped(mac, `${bin}/darwin/arm64/onnxruntime_binding.node`), false);
  assert.equal(dropped(mac, `${bin}/darwin/arm64/libonnxruntime.1.dylib`), false);
  assert.equal(dropped(mac, `${bin}/darwin/arm64/libonnxruntime.1.24.3.dylib`), true, 'the versioned copy is a duplicate');
  assert.equal(dropped(mac, `${bin}/linux/x64/libonnxruntime.so.1`), true);
  assert.equal(dropped(mac, `${bin}/win32/arm64/onnxruntime.dll`), true);
  assert.equal(dropped(mac, '/node_modules/onnxruntime-node/dist/index.js'), false);
  assert.equal(mac.unpack, '**/node_modules/onnxruntime-node/bin/**');
  const win = await autoRoutePackaging({ platform: 'win32', arch: 'x64', fetch });
  assert.equal(dropped(win, `${bin}/win32/x64/DirectML.dll`), false);
  assert.equal(dropped(win, `${bin}/win32/arm64/DirectML.dll`), true);
  const intelMac = await autoRoutePackaging({ platform: 'darwin', arch: 'x64', fetch });
  assert.equal(dropped(intelMac, `${bin}/darwin/arm64/onnxruntime_binding.node`), true, 'macOS x64 has no build to keep');
});

// A runtime whose outputs the synthetic oracles below are computed from, so every comparison can pass or be broken.
const STUMPS = `tree\nnum_class=4\nnum_tree_per_iteration=4\nmax_feature_idx=379\nobjective=multiclass num_class:4\n\n${[0, 1, 0, 0]
  .map(
    (v, i) =>
      `Tree=${i}\nnum_leaves=1\nnum_cat=0\nsplit_feature=\nthreshold=\ndecision_type=\nleft_child=\nright_child=\nleaf_value=${v}\n`,
  )
  .join('\n')}end of trees\n`;
function syntheticRuntime(over: Record<string, any> = {}) {
  const features = new Float32Array(380).fill(0.25);
  const prepared = { ids: BigInt64Array.of(1n, 2n), mask: BigInt64Array.of(1n, 0n) };
  const numeric = Float32Array.of(0.5);
  const intentProbs = { new_task: 0.1, continue: 0.8, redo: 0.1 };
  const runtime = {
    tierModel: lgb.parseLightGBM(STUMPS),
    tokenizer: { encode: (t: string) => [t.length] },
    featurizer: { tierFeatures: async () => features },
    predict: async () => ({ intentProbs, prepared, numeric }),
    close: recorder(async () => {}),
    ...over,
  };
  return { runtime, features, prepared, numeric, intentProbs };
}
function syntheticFixtures(s: ReturnType<typeof syntheticRuntime>) {
  const probs = lgb.calibrate(lgb.predictProbabilities(s.runtime.tierModel, s.features), 1.090874386298676);
  const h = (t: any) => sha(Buffer.from(t.buffer, t.byteOffset, t.byteLength));
  return {
    tokens: { cases: [{ text: 'abc', ids: [3] }] },
    tier: {
      cases: [{ sample_id: 's1', features: Array.from(s.features), expected: { calibrated_class: 'C1', calibrated_probabilities: probs } }],
    },
    source: {
      cases: [
        {
          name: 'c1',
          input: { current_request: 'x' },
          features: Array.from(s.features),
          tier_probabilities: { C0: probs[0], C1: probs[1], C2: probs[2], C3: probs[3] },
        },
      ],
    },
    intent: {
      runtime_profiles: { arm64: {} },
      cases: [
        {
          name: 'c1',
          decision: 'continue',
          prepared_sha256: { input_ids: h(s.prepared.ids), attention_mask: h(s.prepared.mask), numeric88: h(s.numeric) },
          probabilities: { new_task: 0.5, continue: 0.4, redo: 0.1 },
          runtime_probabilities: { arm64: s.intentProbs },
        },
      ],
    },
  };
}

test('parity: a runtime that matches every oracle passes, and each kind of divergence is reported', async () => {
  const s = syntheticRuntime();
  const good = await parity.checkParity({ runtime: s.runtime, fixtures: syntheticFixtures(s) });
  assert.deepEqual(good.failures, []);
  assert.equal(good.report.tokenizer.mismatches, 0);
  assert.equal(good.report.intentProfileMaxAbs.arm64, 0);
  assert.equal(good.report.intent[0].sameInputs, true);

  const fixtures = syntheticFixtures(s);
  fixtures.tokens.cases[0].ids = [9];
  fixtures.tier.cases[0].expected.calibrated_class = 'C2';
  fixtures.tier.cases[0].expected.calibrated_probabilities = [1, 0, 0, 0];
  fixtures.source.cases[0].features = fixtures.source.cases[0].features.map((v, i) => (i === 0 ? v + 0.1 : i === 70 ? v + 0.1 : v));
  fixtures.source.cases[0].tier_probabilities = { C0: 1, C1: 0, C2: 0, C3: 0 };
  fixtures.intent.cases[0].prepared_sha256.numeric88 = '0';
  fixtures.intent.cases[0].decision = 'redo';
  fixtures.intent.cases[0].probabilities = { new_task: 1, continue: 0, redo: 0 };
  fixtures.intent.cases[0].runtime_probabilities.arm64 = { new_task: 1, continue: 0, redo: 0 };
  const bad = await parity.checkParity({ runtime: s.runtime, fixtures });
  const joined = bad.failures.join('\n');
  for (const expected of [
    'tokenizer differs',
    'tier golden s1: class',
    'tier goldens differ',
    'non-BGE features differ',
    'BGE/PCA features differ',
    'tier probabilities differ',
    'c1: tier label',
    'prepared intent inputs differ',
    'intent label continue, expected redo',
    'match no measured profile',
  ])
    assert.ok(joined.includes(expected), `${expected} in:\n${joined}`);
  assert.equal(parity.BOUNDS.tierGolden, 1e-6);
  assert.equal(parity.readFixtures().tokens.cases.length >= 41, true, 'the checked-in oracles load');
});

test('parity: the command line fetches when needed, refuses offline, prints the report and closes the runtime', async () => {
  const s = syntheticRuntime();
  const fixtures = () => syntheticFixtures(s);
  const fetch = recorder(async () => {});
  const log = recorder();
  const load = recorder(async () => s.runtime);
  assert.equal(await parity.main(['--dir', 'x'], { isComplete: () => false, fetch, load, loadOrt: () => 'ort', fixtures, log }), 0);
  assert.deepEqual(fetch.calls[0], [{ out: path.resolve('x') }]);
  assert.deepEqual(load.calls[0], [{ dir: path.resolve('x'), ort: 'ort' }]);
  assert.match(log.calls.at(-1)?.[0], /parity passed/);
  assert.equal(s.runtime.close.calls.length, 1);
  const error = recorder();
  assert.equal(await parity.main(['--offline'], { isComplete: () => false, fetch, error }), 1);
  assert.match(error.calls[0][0], /not in .*auto-route.*--offline/);
  const viaRealOrt = recorder(async () => s.runtime);
  assert.equal(await parity.main([], { isComplete: () => true, load: viaRealOrt, fixtures, log }), 0);
  assert.equal(typeof viaRealOrt.calls[0][0].ort.InferenceSession, 'function', 'the default loads onnxruntime-node');
  const broken = () => ({ ...syntheticFixtures(s), tokens: { cases: [{ text: 'a', ids: [0] }] } });
  assert.equal(await parity.main([], { isComplete: () => true, load, loadOrt: () => 'ort', fixtures: broken, log, error }), 1);
  assert.match(error.calls.at(-1)?.[0], /parity FAILED/);
  assert.equal(s.runtime.close.calls.length, 3);
  const empty = tempDir('auto-route-parity-');
  try {
    const r = runScript('scripts/auto-route/parity.mjs', ['--dir', empty, '--offline']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /run without --offline to fetch them/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
