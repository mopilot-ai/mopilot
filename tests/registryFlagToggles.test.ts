// Installed registry flags retain kill-only defaults alongside schema-2 toggles and per-instance platform definitions.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { ACP_CATALOG, ACP_IDS, ACP_PUBLIC_IDS, registerRegistryAgents } from '../shared/harnessCatalog.mjs';
import { agent, directory } from './support/acp-registry.ts';
import { SHIPPED_OFF_NATIVE } from './support/native-build-flags.ts';

const { Flags, DEFAULTS, SCHEMA, sanitize } = createRequire(import.meta.url)('../electron/platform/flags.cjs');
const reply = (body: unknown) => async () => ({ ok: true, json: async () => body });

function setup(t: TestContext, extra: Record<string, unknown> = {}) {
  const root = directory();
  const id = 'registry-flag-integration';
  const key = `harness.acp.${id}.enabled`;
  const options = {
    file: path.join(root, 'flags.json'),
    url: 'https://example.com/flags',
    channel: () => 'stable',
    version: '1',
    now: () => 1000,
    fetch: reply({}),
    ...extra,
  };
  t.after(() => {
    delete ACP_CATALOG[id];
    for (const ids of [ACP_IDS, ACP_PUBLIC_IDS]) {
      const index = ids.indexOf(id);
      if (index !== -1) ids.splice(index, 1);
    }
    fs.rmSync(root, { recursive: true });
  });
  return { id, key, options, flags: new Flags(options), install: () => registerRegistryAgents([agent('flag-integration')]) };
}

test('an agent installed after flag startup joins snapshots without enabling unknown or build-disabled native identities', async (t) => {
  const { flags, key, install } = setup(t);
  assert.equal(flags.isEnabled(key), false);
  install();
  assert.equal(flags.isEnabled(key), true);
  assert.equal(flags.snapshot()[key], true);
  assert.equal(Object.hasOwn(DEFAULTS, key), false, 'native defaults are immutable');
  const unknown = 'harness.acp.registry-never-installed.enabled';
  flags.o.fetch = reply({ schema: SCHEMA, flags: { [key]: true, [unknown]: true, [SHIPPED_OFF_NATIVE]: true } });
  assert.equal(await flags.refresh(), true);
  assert.equal(flags.isEnabled(key), true);
  assert.equal(flags.isEnabled(unknown), false);
  assert.equal(flags.isEnabled(SHIPPED_OFF_NATIVE), false);
  assert.deepEqual(sanitize({ [key]: false, [unknown]: true, [key + '.extra']: false }), { [key]: false });
});

for (const schema of ['legacy', 'schema-2']) {
  test(`${schema} registry kills persist, report and lift without becoming toggle flags`, async (t) => {
    const killed: string[] = [];
    const changes: Record<string, boolean>[] = [];
    const { flags, key, options, install } = setup(t, {
      onKill: (key: string) => killed.push(key),
      onChange: (snapshot: Record<string, boolean>) => changes.push(snapshot),
    });
    install();
    const body = (value: boolean) => (schema === 'legacy' ? { [key]: value } : { schema: SCHEMA, flags: { [key]: value } });
    flags.o.fetch = reply(body(false));
    assert.equal(await flags.refresh(), true);
    assert.equal(flags.isEnabled(key), false);
    assert.equal(changes.at(-1)?.[key], false);
    assert.deepEqual(killed, [key]);
    const restored = new Flags(options);
    assert.equal(restored.isEnabled(key), false, 'cached registry kill survives restart');
    assert.equal(new Flags({ ...options, version: '2' }).isEnabled(key), true, 'other versions use their defaults');
    flags.o.fetch = reply(body(true));
    assert.equal(await flags.refresh(), true);
    assert.equal(flags.isEnabled(key), true);
    assert.equal(flags.toggles.has(key), false);
    assert.deepEqual(killed, [key]);
  });
}

test('per-instance defaults and schema-2 toggles remain independent of dynamic registry kill flags', async (t) => {
  const toggle = 'test.registry-neighbor';
  const off = 'test.platform-off';
  const defs = [
    { key: toggle, default: false, mode: 'toggle' },
    { key: off, default: true, win32: false, mode: 'kill' },
  ];
  const { flags, key, install } = setup(t, { defs, platform: 'win32' });
  install();
  flags.o.fetch = reply({ schema: SCHEMA, flags: { [toggle]: true, [off]: true, [key]: false } });
  assert.equal(await flags.refresh(), true);
  assert.equal(flags.isEnabled(toggle), true);
  assert.equal(flags.isEnabled(off), false);
  assert.equal(flags.isEnabled(key), false);
  assert.equal(flags.snapshot()[toggle], true);
});
