// The shared Plugins page's marketplaces and dialogs: adding, updating and removing a marketplace, the official
// sources, the confirmation, and the review before an install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calls,
  toasts,
  fake,
  StorePage,
  TrustDialog,
  AddMarketplaceDialog,
  ConfirmDialog,
  commandsOf,
  spec,
  rowOf,
  seg,
  dialogOf,
  key,
  press,
  button,
  mount,
  click,
  change,
  flush,
  h,
} from './support/plugin-store-page.ts';

test('marketplaces: add from the dialog, update, and remove after asking; a refusal says why', async () => {
  const r = await mount(h(StorePage));
  await flush();
  await seg(r.host, 'marketplaces');
  assert.equal(r.host.querySelector('[aria-label="Search plugins"]'), null);
  assert.match(rowOf(r.host, 'acme').textContent!, /3 plugins · https:\/\/x\/acme\.git#v1/);
  assert.match(rowOf(r.host, 'local').textContent!, /No marketplace\.json/);
  assert.match(rowOf(r.host, 'plain').textContent!, /0 plugins · https:\/\/x\/plain\.git/);
  assert.match(rowOf(r.host, 'mine').textContent!, /\/Users\/me\/mkt/);
  assert.equal(button(rowOf(r.host, 'local'), 'Update'), undefined, 'a local folder has nothing to update');

  await click(button(r.host, 'Add marketplace'));
  const input = () => dialogOf(r.host).querySelector('[aria-label="Marketplace source"]') as HTMLInputElement;
  const add = () => button(dialogOf(r.host), /^Add$/) as HTMLButtonElement;
  const submit = async () => {
    await (await import('react')).act(async () =>
      dialogOf(r.host).dispatchEvent(new (window as any).Event('submit', { bubbles: true, cancelable: true })),
    );
    await flush();
  };
  await submit();
  assert.equal(
    calls.some(([n]) => n === 'marketplaceAdd'),
    false,
    'an empty source adds nothing',
  );
  await change(input(), ' owner/repo ');
  await submit();
  assert.deepEqual(toasts.at(-1), ['Added added-owner/repo']);
  assert.equal(dialogOf(r.host), null);
  fake.marketplaceAdd = async () => {
    throw new Error('not a marketplace');
  };
  await click(button(r.host, 'Add marketplace'));
  await change(input(), 'x/y');
  await submit();
  assert.deepEqual(toasts.at(-1), ['not a marketplace', 'error']);
  assert.equal(input().value, 'x/y', 'stays open to fix it');
  assert.equal(add().disabled, false);
  await click(button(dialogOf(r.host), 'Cancel'));

  await click(button(rowOf(r.host, 'acme'), 'Update'));
  await flush();
  assert.deepEqual(toasts.at(-1), ['Updated acme']);
  fake.marketplaceUpgrade = async () => {
    throw new Error('offline');
  };
  await click(button(rowOf(r.host, 'acme'), 'Update'));
  await flush();
  assert.deepEqual(toasts.at(-1), ['offline', 'error']);
  await click(button(rowOf(r.host, 'local'), 'Remove'));
  assert.equal(
    calls.some(([n]) => n === 'marketplaceRemove'),
    false,
    'asks first',
  );
  assert.match(dialogOf(r.host).textContent!, /Remove local\?Plugins you installed from it stay installed\./);
  await click(button(dialogOf(r.host), 'Remove'));
  await flush();
  assert.deepEqual(
    calls.find(([n]) => n === 'marketplaceRemove'),
    ['marketplaceRemove', 'local'],
  );
  assert.deepEqual(toasts.at(-1), ['Removed local']);
  fake.marketplaceRemove = async () => {
    throw new Error('busy');
  };
  await click(button(rowOf(r.host, 'mine'), 'Remove'));
  await click(button(dialogOf(r.host), 'Remove'));
  await flush();
  assert.deepEqual(toasts.at(-1), ['busy', 'error']);
  fake.uninstall = async () => {
    throw new Error('locked');
  };
  await r.unmount();
});

test('the add dialog offers the official sources not yet added, one press away, and closes like the others', async () => {
  const closed: string[] = [];
  const onClose = () => closed.push('closed');
  const r = await mount(
    h(AddMarketplaceDialog, {
      added: [
        { name: 'o', source: { kind: 'git', url: 'https://github.com/openai/plugins.git' }, marketplace: null, error: null },
        { name: 'l', source: { kind: 'local', path: '/anthropics/claude-plugins-official' }, marketplace: null, error: null },
      ],
      onClose,
    }),
  );
  assert.equal(button(r.host, /^Add$/) !== undefined, true);
  assert.equal(r.host.querySelector('[aria-label="Add OpenAI plugins"]'), null);
  await click(r.host.querySelector('[aria-label="Add Anthropic plugins"]'));
  await flush();
  assert.deepEqual(calls.at(-1), ['marketplaceAdd', 'anthropics/claude-plugins-official']);
  assert.deepEqual(closed, ['closed']);
  await r.render(h(AddMarketplaceDialog, { added: null, onClose }));
  assert.ok(r.host.querySelector('[aria-label="Add OpenAI plugins"]'));
  // Adding… while a source is being fetched
  let finish: (v: string) => void = () => undefined;
  fake.marketplaceAdd = () => new Promise((res) => (finish = res));
  await click(r.host.querySelector('[aria-label="Add OpenAI plugins"]'));
  assert.ok(button(r.host, 'Adding…'));
  await (await import('react')).act(async () => finish('openai'));
  await flush();
  closed.length = 0;
  await key('Escape');
  await key('Enter');
  await press(dialogOf(r.host));
  await press(r.host.querySelector('.sketch-backdrop')!);
  await click(r.host.querySelector('[aria-label="Close dialog"]'));
  assert.deepEqual(closed, ['closed', 'closed', 'closed']);
  await r.unmount();
});

test('the confirmation closes on Escape, a press outside it, or its close button', async () => {
  const closed: string[] = [];
  const r = await mount(
    h(ConfirmDialog, { title: 'T', detail: 'D', action: 'Go', onConfirm: () => closed.push('go'), onClose: () => closed.push('closed') }),
  );
  await key('Escape');
  await key('Enter');
  await press(dialogOf(r.host));
  await press(r.host.querySelector('.sketch-backdrop')!);
  await click(r.host.querySelector('[aria-label="Close dialog"]'));
  await click(button(dialogOf(r.host), 'Go'));
  assert.deepEqual(closed, ['closed', 'closed', 'closed', 'go']);
  await r.unmount();
});

test('per-harness plans: the commands once each, the raw configuration behind a disclosure, bookkeeping off the list', async () => {
  const source = (component: string, raw: unknown) => ({ source: 's', state: 'read', component, raw });
  const plan = (sources: unknown[]) => ({
    state: 'supported',
    reasons: [],
    ignored: [],
    sources,
    mcpServers: {},
    hooks: [],
    hookEvents: [],
  });
  const hooks = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stopped' }] }] } };
  const execution = {
    version: 1,
    plans: {
      claude: plan([
        source('hooks', hooks),
        source('manifest', { name: 'p', author: { url: 'https://author.example' } }),
        source('manifest', 'odd'),
      ]),
      codex: plan([source('hooks', hooks), source('manifest', { mcpServers: { s: { command: 'node', args: ['s.js'], env: { A: 1 } } } })]),
      acp: plan([source('mcpServers', { r: { url: 'https://remote.example', args: 'not a list', command: 'plain' } })]),
    },
  };
  const s = spec('p', { execution, lspServers: { ts: { command: 'tsserver' } } }) as any;
  assert.deepEqual(commandsOf(s), ['echo stopped', 'node s.js', 'plain', 'https://remote.example', 'tsserver']);
  assert.deepEqual(commandsOf(spec('p') as any), []);
  const runs = [
    'claude: codex-0.162.0-alpha.17.2 (.claude-plugin/plugin.json)',
    'acp: Hooks are not delivered to ACP.',
    'codex hooks h.json: {}',
  ];
  const r = await mount(
    h(TrustDialog, { preview: { ok: true, spec: s, runs, trust: 't' }, busy: false, onInstall: () => undefined, onClose: () => undefined }),
  );
  assert.equal(
    r.host.querySelector('.plugin-trust-section .plugin-trust-runs')!.textContent,
    'echo stoppednode s.jsplainhttps://remote.exampletsserver',
  );
  assert.equal(r.host.querySelector('details.plugin-trust-config .plugin-trust-runs')!.textContent, 'codex hooks h.json: {}');
  await r.unmount();
  // nothing to run, nothing configured: no disclosure either
  const none = await mount(
    h(TrustDialog, {
      preview: {
        ok: true,
        spec: spec('p', { execution: { version: 1, plans: { claude: plan([]), codex: plan([]), acp: plan([]) } } }) as any,
        runs: [runs[0]],
        trust: 't',
      },
      busy: false,
      onInstall: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.match(none.host.textContent!, /Runs no commands and reaches no remote servers\./);
  assert.equal(none.host.querySelector('details'), null);
  await none.unmount();
});

test('the review closes on Escape or a press outside it, and counts what a plugin brings', async () => {
  const closed: string[] = [];
  const preview = {
    ok: true as const,
    spec: spec('p', {
      description: undefined,
      skills: [],
      commands: [
        { name: 'a', file: '/a' },
        { name: 'b', file: '/b' },
      ],
      hooks: [{ event: 'Stop', command: 'x' }],
      mcpServers: { s: { type: 'http', url: 'https://x', headers: {} } },
    }) as any,
    runs: [],
    trust: 't',
  };
  const r = await mount(h(TrustDialog, { preview, busy: true, onInstall: () => undefined, onClose: () => closed.push('closed') }));
  const dialog = r.host.querySelector('[role=dialog]')!;
  assert.equal(dialog.querySelector('.mk-sub'), null, 'no description, no line');
  assert.match(dialog.textContent!, /Includes 2 commands, 1 MCP server, 1 hook\./);
  // only what differs: the other agents don't run its hooks
  assert.deepEqual(
    [...dialog.querySelectorAll('.plugin-reach-family')].map((f) => f.textContent),
    ['Other agents'],
  );
  assert.equal((button(dialog, 'Installing…') as HTMLButtonElement).disabled, true);
  await key('Escape');
  await key('Enter');
  await press(dialog);
  await press(r.host.querySelector('.sketch-backdrop')!);
  await click(r.host.querySelector('[aria-label="Close dialog"]'));
  assert.deepEqual(closed, ['closed', 'closed', 'closed']);
  await r.render(
    h(TrustDialog, {
      preview: { ...preview, spec: spec('q', { skills: [] }) as any },
      busy: false,
      onInstall: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.match(r.host.textContent!, /Includes nothing to run\./);
  assert.equal(r.host.querySelector('.plugin-reach'), null, 'every harness gets all of it');
  await r.unmount();
});
