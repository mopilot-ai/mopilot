// Panel card replies retain each live request's offered scopes, paired-computer boundaries, input schema and opaque approval lifetime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { cardOf, answerOf } = require('../electron/capabilities/browser/chromePanelCards.cjs');
const { versionOf, currentApproval } = require('../electron/capabilities/browser/chromePanelEpoch.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const host = (kind: string, rest: any = {}) => ({ id: 'sage-1', method: `sage/${kind}`, params: { kind, ...rest } });
const keys = (c: any) => c.choices.map((c: any) => c.key);

test('every owned card is answerable, preserving task, held, remote and nonpersistent scope boundaries', () => {
  const dangerous = host('computerConfirm', {
    origin: 'https://bank.example',
    verb: 'submit',
    summary: 'Confirm details',
    risk: { label: 'Banking', explanation: 'Sensitive' },
  });
  assert.equal(cardOf(dangerous, 'Codex').choices[0].hold, true);
  assert.match(cardOf(dangerous, 'Codex').detail, /Banking/);
  assert.deepEqual(answerOf(dangerous, 'once', 'Codex'), { decision: 'allow', scope: 'once' });
  assert.equal(answerOf(dangerous, 'task', 'Codex'), null);
  const ordinary = host('computerConfirm', { task: true });
  assert.equal(cardOf(ordinary, 'Gemini').choices[0].hold, undefined);
  assert.deepEqual(answerOf(ordinary, 'task', 'Gemini'), { decision: 'allow', scope: 'task' });
  const remote = host('computerAccessSet', {
    apps: [{ bundleId: 'notes', name: 'Notes', tier: 'full', warning: 'Writes files' }],
    denied: [{ name: 'Passwords', reason: 'Restricted' }],
    remote: { hostName: 'Mini' },
    clipboardRead: true,
  });
  assert.match(cardOf(remote, 'Claude Code').title, /Mini/);
  assert.match(cardOf(remote, 'Claude Code').detail, /Restricted/);
  assert.equal(answerOf(remote, 'remember', 'Claude Code'), null);
  assert.deepEqual(answerOf(remote, 'chat', 'Claude Code', { apps: ['notes', 'notes'] }), {
    decision: 'allow',
    apps: ['notes'],
    clipboardRead: true,
    clipboardWrite: undefined,
    systemKeyCombos: undefined,
  });
  for (const apps of [[], ['other'], 'notes']) assert.throws(() => answerOf(remote, 'chat', 'Claude Code', { apps }), /requested apps/);
  const local = host('computerAccessSet', { apps: [{ bundleId: 'notes', name: 'Notes' }] });
  assert.equal(answerOf(local, 'remember', 'Codex').remember, true);
  assert.deepEqual(answerOf(host('computerTakeover', { reason: 'Read the screen' }), 'once', 'Codex'), { decision: 'allow' });
  for (const kind of ['devServer', 'terminalTab'])
    assert.deepEqual(answerOf(host(kind, { command: 'npm run dev', cwd: '/project' }), 'chat', 'Codex'), {
      decision: 'allow',
      scope: 'chat',
    });
  assert.deepEqual(answerOf(host('browserPermission', { origin: 'https://example.com', permissions: ['camera'] }), 'always', 'Codex'), {
    decision: 'allow',
    scope: 'always',
  });
  assert.match(cardOf(host('visionConsent', { vendor: 'Example', model: 'Vision' }), 'Codex').title, /Example.*Vision/);
  assert.equal(answerOf(dangerous, 'deny', 'Codex').decision, 'deny');
});

test('access level replies validate offered levels; local-server permanence can never broaden beyond reading', () => {
  const levels = [
    { id: 'read', label: 'Read only' },
    { id: 'write', label: 'Read and write' },
  ];
  const site = host('browserOrigin', { level: 'write', levels, allowAlways: 'read' });
  assert.ok(keys(cardOf(site, 'Codex')).includes('alwaysRead'));
  assert.deepEqual(answerOf(site, 'alwaysRead', 'Codex', { level: 'write' }), { decision: 'allow', scope: 'always', level: 'read' });
  assert.equal(answerOf(site, 'always', 'Codex'), null);
  assert.deepEqual(answerOf(site, 'chat', 'Codex', { level: 'read' }), { decision: 'allow', scope: 'chat', level: 'read' });
  assert.throws(() => answerOf(site, 'chat', 'Codex', { level: 'admin' }), /offered access/);
  const app = host('computerAccess', { level: 'write', levels });
  assert.throws(() => answerOf(app, 'once', 'Codex', { level: 'read' }), /higher access/);
  assert.deepEqual(answerOf(app, 'once', 'Codex', { level: 'write' }), { decision: 'allow', scope: 'once', level: 'write' });
  assert.equal(answerOf(host('browserOrigin', { remote: { host: 'remote-id' } }), 'always', 'Codex'), null);
  assert.equal(cardOf(host('unsupported'), 'Codex').inApp, true);
});

const empty = { type: 'object', properties: {} };
test('native desktop and browser plugin cards use their existing shared metadata mappings', () => {
  const app = {
    id: 1,
    method: 'mcpServer/elicitation/request',
    params: {
      mode: 'form',
      requestedSchema: empty,
      _meta: {
        connector_id: 'computer-use',
        codex_approval_kind: 'mcp_tool_call',
        tool_params: { app: 'com.apple.TextEdit' },
        persist: ['always', 'session', 'future'],
        tool_params_display: [{ display_name: 'App', value: 'TextEdit' }],
        subtitle: 'Access documents',
        riskLevel: 'high',
      },
    },
  };
  const card = cardOf(app, 'Codex');
  assert.match(card.detail, /Access documents/);
  assert.match(card.detail, /future/);
  assert.deepEqual(answerOf(app, 'always', 'Codex'), { action: 'accept', content: {}, _meta: { persist: 'always' } });
  assert.deepEqual(answerOf(app, 'deny', 'Codex'), { action: 'decline', content: null, _meta: null });
  assert.equal(answerOf(app, 'once', 'Codex'), null);
  const browser = {
    id: 2,
    method: 'mcpServer/elicitation/request',
    params: {
      message: 'Access site?',
      requestedSchema: empty,
      _meta: {
        connector_id: 'browser-use',
        codex_approval_kind: 'mcp_tool_call',
        tool_name: 'access_browser_origin',
        origin: 'https://example.com',
        persist: ['always'],
        reason: 'Read page',
        riskLevel: 'high',
        codex_sensitive_action: true,
      },
    },
  };
  assert.equal(keys(cardOf(browser, 'Codex')).includes('allSites'), false);
  const all = cardOf(browser, 'Codex', { allowAllSites: true });
  assert.match(all.choices.find((c: any) => c.key === 'allSites').confirm, /every site/);
  assert.match(all.detail, /Sensitive action/);
  assert.equal(answerOf(browser, 'allSites', 'Codex'), null);
  assert.deepEqual(answerOf(browser, 'allSites', 'Codex', undefined, { allowAllSites: true }), {
    action: 'accept',
    content: {},
    _meta: { persist: 'always', browser_use_persistent_approval_scope: 'all-sites' },
  });
  assert.deepEqual(answerOf(browser, 'deny', 'Codex'), { action: 'decline', content: null, _meta: null });
});

test('legacy approvals, requested permissions, and Claude browser suggestions retain exact protocol responses', () => {
  for (const method of ['execCommandApproval', 'applyPatchApproval']) {
    const a = { id: 1, method, params: { command: ['ls'], fileChanges: { 'file.txt': {} } } };
    assert.equal(answerOf(a, 'once', 'Codex').decision, 'approved');
    assert.equal(answerOf(a, 'session', 'Codex').decision, 'approved_for_session');
    assert.equal(answerOf(a, 'deny', 'Codex').decision, 'denied');
  }
  const p = {
    id: 2,
    method: 'item/permissions/requestApproval',
    params: { reason: 'Read outside project', permissions: { network: { enabled: true } } },
  };
  assert.deepEqual(answerOf(p, 'turn', 'Codex'), { scope: 'turn', permissions: p.params.permissions });
  assert.deepEqual(answerOf(p, 'deny', 'Codex'), { scope: 'turn', permissions: {} });
  const chrome = {
    id: 'cperm-1',
    method: 'claude/permission',
    params: {
      toolName: 'mcp__claude-in-chrome__navigate',
      input: { url: 'https://example.com' },
      suggestions: [
        { type: 'addRules', rules: [{ toolName: 'mcp__claude-in-chrome__navigate' }], behavior: 'allow', destination: 'session' },
      ],
    },
  };
  assert.ok(keys(cardOf(chrome, 'Claude Code')).includes('session'));
  assert.deepEqual(answerOf(chrome, 'session', 'Claude Code'), { decision: 'acceptForSession' });
});

test('opaque versions survive harmless state rehydration but retire on changed content, withdrawal and reused ids', () => {
  const state = new SessionStore();
  const a = host('computerConfirm');
  state.patch('chat', { approvals: [a] });
  const v1 = versionOf(state, 'chat', a);
  assert.equal(versionOf(state, 'chat', { ...a }), v1);
  assert.deepEqual(currentApproval(state, 'chat', a.id, v1), a);
  assert.equal(currentApproval(state, 'chat', 'missing', v1), null);
  const changed = { ...a, params: { ...a.params, verb: 'delete' } };
  state.patch('chat', { approvals: [changed] });
  const v2 = versionOf(state, 'chat', changed);
  assert.notEqual(v2, v1);
  assert.equal(currentApproval(state, 'chat', a.id, v1), null);
  state.patch('chat', { approvals: [] });
  state.patch('chat', { approvals: [changed] });
  assert.notEqual(versionOf(state, 'chat', changed), v2);
  assert.equal(currentApproval(state, 'chat', a.id, v2), null);
  assert.equal(versionOf({} as any, 'chat', a), versionOf({} as any, 'chat', a));
});

test('minimal card metadata keeps readable fallbacks and grants only the scopes actually offered', () => {
  for (const params of [
    { toolName: 'mcp__claude-in-chrome__unknown', input: {} },
    { toolName: 'mcp__claude-in-chrome__navigate', input: { url: 'chrome://settings' } },
    { toolName: 'Read', input: undefined },
  ]) {
    const req = { id: 1, method: 'claude/toolApproval', params };
    assert.match(cardOf(req, 'Agent').title, /Allow/);
    assert.equal(answerOf(req, 'once', 'Agent').decision, 'accept');
  }
  for (const method of ['execCommandApproval', 'applyPatchApproval', 'item/permissions/requestApproval']) {
    const req = { id: 1, method, params: { command: 'pwd' } };
    assert.ok(cardOf(req, 'Agent').title);
    assert.ok(answerOf(req, method === 'item/permissions/requestApproval' ? 'turn' : 'once', 'Agent'));
  }
  const browser = {
    id: 1,
    method: 'mcpServer/elicitation/request',
    params: {
      _meta: {
        connector_id: 'browser-use',
        codex_approval_kind: 'mcp_tool_call',
        tool_name: 'access_browser_origin',
        origin: 'https://example.org',
      },
      requestedSchema: empty,
    },
  };
  assert.match(cardOf(browser, 'Agent').title, /browser/);
  assert.equal(answerOf(browser, 'deny', 'Agent').action, 'decline');
  const access = host('computerAccessSet', {
    apps: [{ bundleId: 'notes', name: 'Notes', tierLabel: 'Read', tier: 'read' }],
    denied: [{ name: 'App' }],
  });
  assert.deepEqual(answerOf(access, 'chat', 'Agent').apps, ['notes']);
  assert.equal(answerOf(host('computerAccessSet'), 'chat', 'Agent').apps.length, 0);
  assert.match(cardOf(host('computerConfirm', { remote: { host: 'mini' } }), 'Agent').title, /mini/);
  assert.match(cardOf(host('browserPermission'), 'Agent').title, /use your/);
  assert.match(cardOf(host('visionConsent'), 'Agent').title, /vision provider.*its model/);
  assert.throws(() => answerOf(host('computerAccess'), 'once', 'Agent', { level: 'write' }), /offered/);
});

test('empty browser names and JavaScript details remain readable; native low-risk metadata need not contain warnings or a host', () => {
  const bare = { id: 1, method: 'claude/toolApproval', params: { toolName: 'mcp__claude-in-chrome__' } };
  assert.match(cardOf(bare, 'Agent').title, /use Chrome/);
  const script = { ...bare, params: { toolName: 'mcp__claude-in-chrome__javascript_tool', input: { text: 'document.title' } } };
  assert.match(cardOf(script, 'Agent').detail, /document.title/);
  const native = {
    id: 2,
    method: 'mcpServer/elicitation/request',
    params: {
      mode: 'form',
      requestedSchema: empty,
      _meta: { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call', tool_params: { app: 'Notes' }, riskLevel: 'low' },
    },
  };
  assert.equal(cardOf(native, 'Agent').detail, null);
  const browser = {
    id: 3,
    method: 'mcpServer/elicitation/request',
    params: {
      requestedSchema: empty,
      _meta: { connector_id: 'browser-use', codex_approval_kind: 'mcp_tool_call', tool_name: 'access_browser_origin' },
    },
  };
  assert.ok(cardOf(browser, 'Agent').title);
});

test('a terminal card for one command line names the line and allows that line once; opening a tab stays chat-wide', () => {
  const line = host('terminalTab', { command: 'npm test', cwd: '/project' });
  assert.match(cardOf(line, 'Codex').title, /run a command in a terminal/);
  assert.match(cardOf(line, 'Codex').detail, /npm test/);
  assert.equal(cardOf(line, 'Codex').choices[0].label, 'Allow once');
  const open = host('terminalTab', { cwd: '/project' });
  assert.match(cardOf(open, 'Codex').title, /open a terminal/);
  assert.equal(cardOf(open, 'Codex').choices[0].label, 'Allow in this chat');
  assert.equal(cardOf(host('devServer', { command: 'npm run dev', cwd: '/p' }), 'Codex').choices[0].label, 'Allow in this chat');
});

test('a high-risk site action card offers Always allow on this site, never for a paired computer (#5464)', () => {
  const site = host('computerConfirm', { origin: 'https://www.americanexpress.com', verb: 'act on a high-risk site', siteAlways: true });
  assert.deepEqual(keys(cardOf(site, 'Codex')), ['once', 'always', 'deny']);
  assert.equal(cardOf(site, 'Codex').choices[0].hold, true);
  assert.deepEqual(answerOf(site, 'always', 'Codex'), { decision: 'allow', scope: 'always' });
  const remote = host('computerConfirm', { siteAlways: true, remote: { host: 'h', hostName: 'Mini' } });
  assert.deepEqual(keys(cardOf(remote, 'Codex')), ['once', 'deny']);
  assert.equal(answerOf(remote, 'always', 'Codex'), null);
  assert.equal(answerOf(host('computerConfirm', {}), 'always', 'Codex'), null);
});
