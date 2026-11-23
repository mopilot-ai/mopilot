// The trust dialog counts inert LSP configurations, discloses their commands and qualifies native availability.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { mount, iconStubs } from './support/harness-ui-kit.ts';
import { whatRuns } from '../shared/plugins/manifest.mjs';

mock.module('../src/components/ui/icons.tsx', { namedExports: iconStubs() });
const { TrustDialog } = await import('../src/components/plugins/TrustDialog.tsx');

test('an LSP-only plugin is never described as empty and unsupported harnesses are explicit', async () => {
  const spec = {
    name: 'language',
    displayName: 'Language',
    layout: 'none',
    root: '/inert',
    skills: [],
    commands: [],
    agents: [],
    hooks: [],
    mcpServers: {},
    apps: [],
    problems: [],
    lspServers: { language: { command: 'inert-server', args: ['--stdio'], env: { INERT: 'value' } } },
  };
  const r = await mount(
    h(TrustDialog, {
      preview: { ok: true, spec, runs: whatRuns(spec), trust: 'fixture' },
      busy: false,
      onInstall: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.match(r.host.textContent!, /Includes 1 LSP server\./);
  assert.match(r.host.textContent!, /lsp language: .*inert-server.*--stdio.*INERT/);
  assert.doesNotMatch(r.host.textContent!, /nothing to run|runs no commands/);
  assert.match(r.host.textContent!, /LSP servers need Claude Code and their language servers\./);
  const rows = [...r.host.querySelectorAll('.plugin-reach-row')];
  // only what differs is listed: Claude Code gets all of it
  assert.equal(
    rows.find((row) => row.textContent?.startsWith('Claude Code')),
    undefined,
  );
  for (const family of ['Codex', 'Other agents']) {
    const row = rows.find((row) => row.textContent?.startsWith(family));
    assert.ok(row?.classList.contains('none'));
    assert.match(row!.textContent!, /LSP configuration only to Claude Code/);
  }
  await r.unmount();
});

test('the LSP disclosure is absent for a legacy empty plugin', async () => {
  const spec = {
    name: 'empty',
    displayName: 'Empty',
    layout: 'none',
    root: '/inert',
    skills: [],
    commands: [],
    agents: [],
    hooks: [],
    mcpServers: {},
    apps: [],
    problems: [],
  };
  const r = await mount(
    h(TrustDialog, {
      preview: { ok: true, spec, runs: [], trust: 'fixture' },
      busy: false,
      onInstall: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.match(r.host.textContent!, /Includes nothing to run\./);
  assert.doesNotMatch(r.host.textContent!, /LSP/);
  await r.unmount();
});
