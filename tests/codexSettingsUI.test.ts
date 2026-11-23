// Renders the real Codex settings components with their app modules stubbed. A failure must say so, not
// look done or spin forever: Configuration when config.toml can't be read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixture,
  mount,
  createElement,
  act,
  window,
  Configuration,
  ImportSection,
  Hooks,
  importSource,
} from './support/codex-settings-kit.ts';

test('Configuration waits while config.toml is being read, and shows a read failure with a retry', async () => {
  const waiting = await mount(createElement(Configuration, { part: 'models' }));
  try {
    assert.equal(waiting.host.textContent, '', 'only the (stubbed) spinner');
  } finally {
    await waiting.dispose();
  }
  fixture.state.configError = 'config/read timed out';
  const failed = await mount(createElement(Configuration, { part: 'models' }));
  try {
    assert.match(failed.host.textContent!, /Couldn't read config\.toml: config\/read timed out/);
    await failed.click('Retry');
    assert.deepEqual(fixture.calls, ['loadConfig']);
  } finally {
    await failed.dispose();
  }
  // once a config is read, the page shows it, whatever an earlier read said
  fixture.state.config = {};
  for (const part of ['models', 'cli']) {
    const shown = await mount(createElement(Configuration, { part }));
    try {
      assert.doesNotMatch(shown.host.textContent!, /Couldn't read/, part);
    } finally {
      await shown.dispose();
    }
  }
});

const { createConfigLoader } = await import('../src/store/config.ts');
const store: { state: Record<string, unknown>; read: () => Promise<{ config: unknown }> } = {
  state: {},
  read: async () => ({ config: {} }),
};
const loadConfig = createConfigLoader(
  () => store.read(),
  (patch) => {
    Object.assign(store.state, patch);
  },
);

test('loadConfig records why a read failed and clears it once a read works', async () => {
  store.state = { config: null, configError: null };
  store.read = async () => {
    throw new Error('app-server closed');
  };
  await loadConfig();
  assert.deepEqual(store.state, { config: null, configError: 'app-server closed' });
  store.read = () => Promise.reject('offline');
  await loadConfig();
  assert.equal(store.state.configError, 'offline');
  store.read = async () => ({ config: { model: 'gpt-5' } });
  await loadConfig();
  assert.deepEqual(store.state, { config: { model: 'gpt-5' }, configError: null });
});

test('importSource names the app a detected item came from', () => {
  const item = (description: string, cwd: string | null = null) => ({ itemType: 'AGENTS_MD', description, cwd, details: null }) as any;
  assert.deepEqual(importSource(item('Rules from ~/.cursor/rules')), { id: 'cursor', name: 'Cursor' });
  assert.deepEqual(importSource(item('Claude Cowork skills')), { id: 'claude-cowork', name: 'Claude Cowork' });
  assert.deepEqual(importSource(item('Copy CLAUDE.md')), { id: 'claude-code', name: 'Claude Code' });
  assert.deepEqual(importSource(item('Windsurf rules')), { id: 'other', name: 'Windsurf rules' });
});

test('ImportSection detects setup, imports a source and records it, or shows why it failed', async () => {
  const cursorItem = { itemType: 'AGENTS_MD', description: '.cursor rules', cwd: '/proj', details: null };
  const claudeItems = [
    { itemType: 'SKILLS', description: 'Claude skills', cwd: null, details: null },
    { itemType: 'MCP_SERVER_CONFIG', description: 'Claude MCP servers', cwd: null, details: null },
  ];
  let detected: unknown[] = [cursorItem, ...claudeItems];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  fixture.answer = async (m: string) => {
    if (m === 'externalAgentConfig/detect') {
      await gate;
      return { items: detected };
    }
    if (m === 'externalAgentConfig/import' && fixture.fail.has(m)) throw new Error('Import refused');
    return {};
  };
  const v = await mount(createElement(ImportSection));
  try {
    assert.ok(v.row('Checking for imports'), 'a spinner row while detecting');
    assert.equal(v.row('Content to sync').querySelector('.row-desc').textContent, 'Available after your first import');
    assert.equal(v.row('Content to sync').querySelector('button').disabled, true);
    await act(async () => release());
    assert.deepEqual(fixture.params[0], ['externalAgentConfig/detect', { includeHome: true, cwds: ['/proj'] }]);
    assert.deepEqual(
      [...v.host.querySelectorAll('.import-src')].map((x) => x.textContent),
      ['Cursor', 'Claude Code'],
      'one row per source app',
    );
    await v.toggle('Keep imports in sync');
    assert.deepEqual(fixture.prefs, [{ importSync: true }]);

    detected = [];
    await act(async () =>
      v
        .row('Claude Code')
        .querySelector('button')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    );
    await v.flush();
    const imported = fixture.params.find(([m]: [string]) => m === 'externalAgentConfig/import');
    assert.deepEqual(imported[1], { migrationItems: claudeItems }, 'every item of that source');
    assert.deepEqual(fixture.prefs.at(-1), { importedSources: ['claude-code'] });
    assert.deepEqual(fixture.toasts, [['Imported from Claude Code']]);
    assert.ok(v.row('Nothing to import'), 'detection reruns after the import');
  } finally {
    await v.dispose();
  }

  // a failed import says why and keeps the sources; a failed detection reads as nothing to import
  fixture.toasts = [];
  fixture.prefs = [];
  fixture.fail.add('externalAgentConfig/import');
  detected = [cursorItem];
  fixture.state.prefs = { importSync: true, importedSources: ['claude-code', 'cursor'] };
  const again = await mount(createElement(ImportSection));
  try {
    await again.flush();
    assert.equal(again.row('Content to sync').querySelector('.row-desc').textContent, 'Syncing 2 sources');
    await again.click('Import');
    await again.flush();
    assert.deepEqual(fixture.toasts, [['Import refused', 'error']]);
    assert.equal(fixture.prefs.length, 0);
    fixture.answer = async (m: string) => {
      if (m === 'externalAgentConfig/import') throw 'disk full';
      return { items: detected };
    };
    await again.click('Import');
    await again.flush();
    assert.deepEqual(fixture.toasts.at(-1), ['disk full', 'error'], 'a bare rejection reason');
    await again.click('Stop syncing');
    assert.deepEqual(fixture.prefs, [{ importedSources: [] }]);
  } finally {
    await again.dispose();
  }
  fixture.state.prefs = { importSync: true, importedSources: ['cursor'] };
  fixture.answer = async () => {
    throw 'no app-server';
  };
  const failed = await mount(createElement(ImportSection));
  try {
    await failed.flush();
    // a detection that failed says so with Retry instead of "Nothing to import"
    assert.equal(failed.host.querySelector('[role="alert"]')!.textContent, "Couldn't look for setup to import: no app-server Retry");
    assert.equal(
      [...failed.host.querySelectorAll('.row-title')].some((t) => t.textContent === 'Nothing to import'),
      false,
    );
    assert.equal(failed.row('Content to sync').querySelector('.row-desc').textContent, 'Syncing one source');
    fixture.answer = async () => ({ items: [] });
    await failed.click('Retry');
    await failed.flush();
    assert.equal(failed.host.querySelector('[role="alert"]'), null);
    assert.ok(failed.row('Nothing to import'));
  } finally {
    await failed.dispose();
  }
  // an app-server that reports no items list
  fixture.state.prefs = {};
  fixture.answer = async () => ({});
  const empty = await mount(createElement(ImportSection));
  try {
    await empty.flush();
    assert.ok(empty.row('Nothing to import'));
    assert.equal(empty.row('Content to sync').querySelector('button').textContent, 'Customize');
  } finally {
    await empty.dispose();
  }
});

test('Configuration writes each models setting to config.toml and reports a failed save', async () => {
  fixture.state.config = { web_search: 'live', model_verbosity: 'low', model_reasoning_summary: 'concise' };
  const v = await mount(createElement(Configuration, { part: 'models' }));
  try {
    assert.equal(v.row('Web search').querySelector('select').value, 'live');
    await v.choose('Web search', 'disabled');
    await v.choose('Output detail', 'default');
    await v.choose('Output detail', 'high');
    await v.choose('Reasoning summary', 'none');
    await v.flush();
    assert.deepEqual(
      fixture.params.filter(([m]: [string]) => m === 'config/value/write').map(([, p]: [string, any]) => [p.keyPath, p.value]),
      [
        ['web_search', 'disabled'],
        ['model_verbosity', null],
        ['model_verbosity', 'high'],
        ['model_reasoning_summary', 'none'],
      ],
    );
    assert.equal(fixture.calls.filter((m: string) => m === 'loadConfig').length, 4, 'reloaded after each write');
    assert.deepEqual(fixture.toasts.at(-1), ['Saved to config.toml']);
    fixture.fail.add('config/value/write');
    await v.choose('Web search', 'cached');
    await v.flush();
    assert.deepEqual(fixture.toasts.at(-1), ["Couldn't save: config/value/write failed", 'error']);
    fixture.answer = async () => {
      throw 'locked';
    };
    await v.choose('Web search', 'live');
    await v.flush();
    assert.deepEqual(fixture.toasts.at(-1), ["Couldn't save: locked", 'error']);
  } finally {
    await v.dispose();
  }
  // unset values show the defaults
  fixture.state.config = {};
  const d = await mount(createElement(Configuration, { part: 'models' }));
  try {
    assert.deepEqual(
      [...d.host.querySelectorAll('select')].map((x: any) => x.value),
      ['cached', 'default', 'auto'],
    );
  } finally {
    await d.dispose();
  }
});

test('Configuration (cli) shows config warnings and opens config.toml once Codex home is known', async () => {
  fixture.state.config = {};
  fixture.state.configWarnings = [
    { summary: 'Unknown key foo', details: 'line 3' },
    { summary: 'Deprecated bar', details: null },
  ];
  const v = await mount(createElement(Configuration, { part: 'cli' }));
  try {
    assert.deepEqual(
      [...v.host.querySelectorAll('.config-warning code')].map((x) => x.textContent),
      ['Unknown key foo', 'line 3', 'Deprecated bar'],
    );
    await v.click('Open config.toml ');
    assert.deepEqual(fixture.opened, [], 'nothing to open before Codex home is known');
  } finally {
    await v.dispose();
  }
  fixture.state.codexHome = '/Users/me/.codex';
  const h = await mount(createElement(Configuration, { part: 'cli' }));
  try {
    await h.click('Open config.toml ');
    assert.deepEqual(fixture.opened, ['/Users/me/.codex/config.toml']);
  } finally {
    await h.dispose();
  }
});

test('Hooks lists hooks by plugin and config, expands a group, and refreshes', async () => {
  const hook = (over: Record<string, unknown>) => ({
    key: String(Math.random()),
    eventName: 'PreToolUse',
    handlerType: 'command',
    matcher: null,
    pluginId: null,
    enabled: true,
    trustStatus: 'trusted',
    ...over,
  });
  fixture.plugins = [{ id: 'stripe@market', name: 'stripe', interface: null }];
  let data: unknown = [
    {
      hooks: [
        hook({ pluginId: 'stripe@market', command: 'stripe-check', matcher: 'Bash' }),
        hook({ pluginId: 'stripe@market', handlerType: 'mcpTool', server: 'pay', tool: 'audit', trustStatus: 'untrusted' }),
      ],
    },
    { hooks: [hook({ handlerType: 'prompt', enabled: false }), hook({ pluginId: 'lint@x' })] },
  ];
  fixture.answer = async (m: string, p: any) => {
    if (m !== 'hooks/list') return {};
    assert.deepEqual(p, { cwds: ['/proj'] });
    if (data === 'fail') throw new Error('hooks/list failed');
    return { data };
  };
  const v = await mount(createElement(Hooks));
  try {
    await v.flush();
    assert.equal(v.host.querySelector('section')?.getAttribute('data-title'), 'From plugins and config');
    assert.deepEqual(
      [...v.host.querySelectorAll('.import-src')].map((x) => x.textContent),
      ['Stripe', 'Config.toml', 'Lint'],
    );
    assert.equal(v.host.querySelectorAll('img.plugin-logo').length, 1, 'a logo for the installed plugin only');
    assert.ok(fixture.calls.includes('loadPlugins'));
    assert.equal(v.row('Stripe').querySelector('.row-desc').textContent, '2 hooks');
    assert.equal(v.row('Lint').querySelector('.row-desc').textContent, '1 hook');
    await v.clickRow('Stripe');
    assert.deepEqual(
      [...v.host.querySelectorAll('.row')]
        .filter((r) => r.querySelector('.row-title')?.textContent === 'PreToolUse')
        .map((r) => [r.querySelector('.row-desc')!.textContent, r.querySelector('.status-pill')!.textContent]),
      [
        ['stripe-check · matcher Bash', 'trusted'],
        ['pay.audit', 'untrusted'],
      ],
    );
    await v.clickRow('Stripe');
    await v.clickRow('Config.toml');
    const configRow = [...v.host.querySelectorAll('.row')].find((r) => r.querySelector('.row-title')?.textContent === 'PreToolUse')!;
    assert.equal(configRow.querySelector('.row-desc')!.textContent, 'prompt');
    assert.equal(configRow.querySelector('.status-pill')!.textContent, 'disabled');

    // plugins only
    data = [{ hooks: [hook({ pluginId: 'lint@x' })] }];
    await act(async () =>
      (v.host.querySelector('button[title="Refresh"]') as any).dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    );
    await v.flush();
    assert.equal(v.host.querySelector('section')?.getAttribute('data-title'), 'From Plugins');
    await v.clickLink('Learn more');
    assert.deepEqual(fixture.opened, ['https://developers.openai.com/codex/hooks']);
    data = 'fail';
    await act(async () =>
      (v.host.querySelector('button[title="Refresh"]') as any).dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    );
    await v.flush();
    // a list that couldn't be read says why with Retry, not that there are no hooks
    assert.equal(v.host.querySelector('.empty-state'), null);
    assert.equal(v.host.querySelector('[role=alert]')?.textContent, "Couldn't list the hooks: hooks/list failed Retry");
    data = [];
    await act(async () =>
      (v.host.querySelector('[role=alert] button') as any).dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    );
    await v.flush();
    assert.equal(v.host.querySelector('[role=alert]'), null);
    assert.equal(v.host.querySelector('.empty-state')?.textContent, 'No hooks configured');
  } finally {
    await v.dispose();
  }
});

test("Hooks for another folder: none of the last folder's hooks show, and its late answer or failure never lands", async () => {
  for (const late of ['answer', 'failure'] as const) {
    const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
    fixture.answer = (m: string, p: any) =>
      m === 'hooks/list' ? new Promise((resolve, reject) => pending.set(p.cwds[0], { resolve, reject })) : Promise.resolve({});
    const hook = (pluginId: string) => ({
      key: pluginId,
      eventName: 'Stop',
      handlerType: 'command',
      matcher: null,
      pluginId,
      enabled: true,
    });
    const sources = () => [...v.host.querySelectorAll('.import-src')].map((x) => x.textContent);
    fixture.cwd = '/a';
    const v = await mount(createElement(Hooks));
    try {
      const first = pending.get('/a')!;
      await act(async () => first.resolve({ data: [{ hooks: [hook('alpha@x')] }] }));
      assert.deepEqual(sources(), ['Alpha']);
      fixture.cwd = '/b';
      await v.rerender(createElement(Hooks));
      assert.deepEqual(sources(), [], "no frame shows /a's hooks under /b");
      await act(async () => pending.get('/b')!.resolve({ data: [{ hooks: [hook('beta@x')] }] }));
      assert.deepEqual(sources(), ['Beta']);
      // back to /a, then to /b again before /a answers
      fixture.cwd = '/a';
      await v.rerender(createElement(Hooks));
      const slow = pending.get('/a')!;
      fixture.cwd = '/b';
      await v.rerender(createElement(Hooks));
      await act(async () => pending.get('/b')!.resolve({ data: [{ hooks: [hook('beta@x')] }] }));
      await act(async () => (late === 'answer' ? slow.resolve({ data: [{ hooks: [hook('alpha@x')] }] }) : slow.reject(new Error('gone'))));
      assert.deepEqual(sources(), ['Beta']);
      assert.equal(v.host.querySelector('[role="alert"]'), null);
    } finally {
      await v.dispose();
      fixture.cwd = undefined;
    }
  }
});
