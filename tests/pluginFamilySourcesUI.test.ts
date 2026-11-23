// Trust and reach render real inert source plans with family differences and recoverable withholding.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import './support/dom.ts';
import { createElement as h } from 'react';
import { mount, iconStubs } from './support/harness-ui-kit.ts';
import { tmp, write } from './support/plugin-store-fixture.ts';
import { whatRuns } from '../shared/plugins/manifest.mjs';

const { readPlugin } = createRequire(import.meta.url)('../electron/plugins/read.cjs');
mock.module('../src/components/ui/icons.tsx', { namedExports: iconStubs() });
const { TrustDialog } = await import('../src/components/plugins/TrustDialog.tsx');
const { reachLine } = await import('../src/components/plugins/ReachStrip.tsx');
const json = (root: string, file: string, value: unknown) => write(path.join(root, file), JSON.stringify(value));

test('same-name native alternatives and ignored defaults remain distinguishable in the actual trust dialog', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  json(root, '.codex-plugin/plugin.json', {
    name: 'inert',
    mcpServers: { shared: { command: 'codex-override', future: { setting: true } } },
  });
  json(root, '.mcp.json', { mcpServers: { shared: { command: 'claude-default' }, extra: { command: 'default-extra' } } });
  const { spec } = await readPlugin(root);
  const r = await mount(
    h(TrustDialog, { preview: { ok: true, spec, runs: whatRuns(spec), trust: 'fixture' }, busy: false, onInstall() {}, onClose() {} }),
  );
  const text = r.host.textContent!;
  assert.match(text, /Includes 2 MCP servers/);
  assert.match(text, /claude mcpServers \.mcp.json: .*claude-default/);
  assert.match(text, /codex manifest \.codex-plugin\/plugin.json: .*codex-override.*setting/);
  assert.match(text, /ignored because \.codex-plugin\/plugin.json declares mcpServers/);
  assert.match(text, /Runs on this Mac:/);
  assert.doesNotMatch(text, /nothing to run/);
  // what runs stays listed; a family's contract and ACP's fixed hook note are not what runs
  assert.doesNotMatch(text, /mopilot-selected-mcp-v1|Hooks are not delivered/);
  await r.unmount();
});

test('withheld native families are explicit even when their projected component list is empty', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  json(root, '.claude-plugin/plugin.json', { name: 'inert' });
  json(root, 'plugin.json', { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' });
  const { spec } = await readPlugin(root);
  assert.deepEqual(reachLine(spec, 'codex'), {
    state: 'none',
    text: 'Nothing runs.  Codex selects a portable root manifest; this source layout is not yet accounted for.',
  });
  assert.equal(reachLine(spec, 'claude').state, 'full');
  const r = await mount(
    h(TrustDialog, { preview: { ok: true, spec, runs: whatRuns(spec), trust: 'fixture' }, busy: false, onInstall() {}, onClose() {} }),
  );
  const row = [...r.host.querySelectorAll('.plugin-reach-row')].find((entry) => entry.textContent?.startsWith('Codex'));
  assert.ok(row?.classList.contains('none'));
  assert.match(row!.textContent!, /portable root manifest/);
  await r.unmount();
});

test('trust disclosure shows native numeric spelling and counts shared hook events once', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(
    path.join(root, '.claude-plugin/plugin.json'),
    '{"name":"inert","hooks":{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"inert-inline","timeout":1.0}]}]}}}',
  );
  json(root, 'hooks/hooks.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'inert-default' }] }] } });
  const { spec } = await readPlugin(root);
  const r = await mount(
    h(TrustDialog, { preview: { ok: true, spec, runs: whatRuns(spec), trust: 'fixture' }, busy: false, onInstall() {}, onClose() {} }),
  );
  assert.match(r.host.textContent!, /Includes 1 hook event\./);
  assert.match(r.host.textContent!, /claude manifest \.claude-plugin\/plugin.json numeric tokens:.*1\.0/);
  assert.match(r.host.textContent!, /codex manifest \.claude-plugin\/plugin.json numeric tokens:.*1\.0/);
  await r.unmount();
});
