// Host E2E module seeds preserve intended liveness when a warm worker delays serializing their registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { parseAst } from 'rolldown/parseAst';
import { useFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { createRegistry, ONLINE_MS } = require('../electron/host/registry.cjs');
export const GUARDS = ['tests/e2e/', 'electron/host/registry.cjs'];

function entries(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(entries);
  return [node, ...Object.values(node).flatMap(entries)];
}

// Evaluate the actual userData expression, including factory arguments and pre-write copies. Lazy top-level bindings
// avoid running unrelated SSH/filesystem setup. An unsupported dependency fails rather than substituting a fake host.
function registries(source: string, now: () => number): any[] {
  const program: any = parseAst(source, { lang: 'ts' });
  const context = createContext({ Date: { now } });
  const values = new Map<string, any>();
  const evaluating = new Set<string>();
  const evaluate = (node: any) => runInContext(stripTypeScriptTypes(`(${source.slice(node.start, node.end)})`), context, { timeout: 1000 });
  for (const statement of program.body.filter((node: any) => node.type === 'VariableDeclaration')) {
    for (const declaration of statement.declarations) {
      if (declaration.id.type !== 'Identifier' || !declaration.init) continue;
      const name = declaration.id.name;
      Object.defineProperty(context, name, {
        get() {
          assert.ok(!evaluating.has(name), `unsupported cyclic seed dependency: ${name}`);
          if (!values.has(name)) {
            evaluating.add(name);
            values.set(name, evaluate(declaration.init));
            evaluating.delete(name);
          }
          return values.get(name);
        },
      });
    }
  }
  return entries(program)
    .filter((node) => node.type === 'Property' && (node.key.name ?? node.key.value) === 'userData')
    .flatMap((node) => {
      const data = evaluate(node.value);
      assert.ok(data && typeof data === 'object', 'userData must remain an evaluable seed object');
      return Object.hasOwn(data, 'host-registry.json') ? [data['host-registry.json']] : [];
    });
}

function verifySeeds(t: any, clock: ReturnType<typeof useFakeClock>, sources: [string, string][]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-fixture-heartbeat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const states = new Set<string>();
  const failures: string[] = [];
  let checked = 0;
  for (const [name, source] of sources) {
    for (const seed of registries(source, clock.now)) {
      assert.ok(Array.isArray(seed.hosts) && seed.hosts.length, `${name}: registry seed must contain hosts`);
      assert.ok(
        seed.hosts.every((host: any) => Object.hasOwn(host, 'lastHeartbeat')),
        `${name}: every host must declare its heartbeat`,
      );
      const file = path.join(root, 'host-registry.json');
      const state = () => {
        fs.writeFileSync(file, JSON.stringify(seed));
        const registry = createRegistry({ file });
        try {
          const rows = registry.list();
          assert.equal(rows.length, seed.hosts.length, `${name}: the real registry must load every seed host`);
          return rows.map((host: any) => host.status as string);
        } finally {
          registry.dispose();
        }
      };
      const cold = state();
      for (const status of cold) states.add(status);
      clock.advance(ONLINE_MS * 2);
      if (JSON.stringify(state()) !== JSON.stringify(cold)) failures.push(`${name}: changed liveness while waiting to write its seed`);
      checked += seed.hosts.length;
    }
  }
  assert.ok(checked > 0, 'the guard must execute actual host seed consumption');
  assert.deepEqual(failures, []);
  return { checked, states };
}

test('host seeds keep online and deliberately offline state after a worker waits longer than the heartbeat lifetime', (t) => {
  const clock = useFakeClock(t, 1_000_000);
  const sources: [string, string][] = fs
    .readdirSync('tests/e2e')
    .filter((name) => /^host-.*\.spec\.ts$/.test(name))
    .map((name) => [name, fs.readFileSync(`tests/e2e/${name}`, 'utf8')]);
  const { checked, states } = verifySeeds(t, clock, sources);
  assert.deepEqual([...states].sort(), ['offline', 'online'], 'exercise live seeds and the deliberately stale machine');
  t.diagnostic(`Checked ${checked} actual heartbeat producers across cold and delayed registry writes.`);
});

test('the actual seed replay rejects eager keys, factory snapshots and copies while accepting lazy equivalent keys', (t) => {
  const clock = useFakeClock(t, 1_000_000);
  const file = 'host-switch-continue.spec.ts';
  const source = fs.readFileSync(`tests/e2e/${file}`, 'utf8');
  const getter = /get lastHeartbeat\(\)\s*\{\s*return Date\.now\(\);\s*\}/;
  assert.match(source, getter);
  for (const key of ['lastHeartbeat', "'lastHeartbeat'", "['lastHeartbeat']", "['last' + 'Heartbeat']"]) {
    assert.throws(() => verifySeeds(t, clock, [[file, source.replace(getter, `${key}: Date.now()`)]]), /changed liveness/);
    verifySeeds(t, clock, [[file, source.replace(getter, `get ${key}() { return Date.now(); }`)]]);
  }
  for (const copy of ['{ ...MACHINE }', 'Object.assign({}, MACHINE)']) {
    assert.ok(source.includes('hosts: [MACHINE]'));
    assert.throws(() => verifySeeds(t, clock, [[file, source.replace('hosts: [MACHINE]', `hosts: [${copy}]`)]]), /changed liveness/);
  }
  const factoryFile = 'host-machine-states.spec.ts';
  const factory = fs.readFileSync(`tests/e2e/${factoryFile}`, 'utf8');
  assert.ok(factory.includes("record('me@box')"));
  assert.throws(
    () => verifySeeds(t, clock, [[factoryFile, factory.replace("record('me@box')", "record('me@box', Date.now())")]]),
    /changed liveness/,
  );
});
