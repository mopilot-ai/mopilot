// electron/harness/claude/index.cjs sessions: the stream a CLI process produces, permission and elicitation cards,
// MoPilot's own tools, controls, the command catalog, edits (rewind) and the idle reaper.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakes, load, fakeBin, flush, until, home, tmp, lastQuery, withCommands } from './support/electron-claude.ts';
import { waitFor } from './support/waitFor.ts';
const bin = fakeBin('sessions/claude');
const user = (text: string) => ({ role: 'user', content: text });
const projects = path.join(home, '.claude', 'projects', 'p');
fs.mkdirSync(projects, { recursive: true });
const transcript = (sid: string, rows: any[]) =>
  fs.writeFileSync(path.join(projects, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const appendRows = (sid: string, rows: any[]) =>
  fs.appendFileSync(path.join(projects, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const of = (t: any, key: string, kind: string) => t.events.filter((e: any) => e.key === key && e.kind === kind);

test('the input channel queues until read, ignores pushes once closed and wakes a waiting reader on close', async () => {
  const { Channel } = load({ register: false }).claude;
  const c = new Channel();
  c.push(1);
  const it = c[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: 1, done: false });
  const waiting = it.next();
  c.push(2);
  assert.deepEqual(await waiting, { value: 2, done: false });
  const last = it.next();
  c.close();
  c.push(3);
  assert.deepEqual(await last, { value: undefined, done: true });
});

test('a send without an installed CLI fails', async () => {
  const t = load();
  await assert.rejects(t.claude.send('claude:none', { bin: path.join(tmp, 'nope'), sessionId: 'none' }, user('hi')), /not installed/);
});

test('a session stream: init reads settings and the catalog, tasks, schedules and live Bash output reach the window', async () => {
  let throwOnce = true;
  const seen: any[] = [];
  const t = load({
    hooks: {
      onEvent: (e: any) => {
        seen.push(e);
        if (throwOnce) {
          throwOnce = false;
          throw new Error('listener failed');
        }
      },
    },
  });
  const sid = '11111111-1111-4111-8111-111111111111';
  const key = `claude:${sid}`;
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  transcript(sid, [{ type: 'user', uuid: 'u0', message: { content: 'old' } }]);
  fakes.onQuery = (q: any) => {
    q.getTaskOutput = async () => ({ output: 'hello\n' });
    q.supportedCommands = async () => [{ name: 'help', description: 'Help', aliases: ['h'], builtin: true }, { name: 'x' }];
    q.reply = (m: any) => [
      {
        type: 'system',
        subtype: 'init',
        skills: ['s1', { name: 's2' }, {}],
        plugins: [{ name: 'p', path: '/p' }, { name: 'q' }],
        terminal_slash_commands: ['/term'],
      },
      { type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'local_bash', tool_use_id: 'tu1', description: 'ls' },
      {
        type: 'assistant',
        uuid: `a-${m.uuid}`,
        message: {
          content: [
            { type: 'tool_use', name: 'CronCreate', input: {} },
            { type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds: 120 } },
          ],
        },
      },
      { type: 'assistant', message: { content: [] } },
      { type: 'result', subtype: 'success' },
    ];
  };
  const others = [[900, 1, `/usr/local/bin/claude --resume ${sid}`]];
  const r = await withCommands(others, () => t.claude.send(key, { bin, sessionId: sid, cwd }, user('one')));
  assert.deepEqual(r, { elsewhere: ['other'] });
  await until('the result', () => of(t, key, 'message').some((e: any) => e.msg.type === 'result'));
  await until('the bash output', () => of(t, key, 'message').some((e: any) => e.msg.subtype === 'sage_bash_output'));
  await until('the catalog commands', () => t.broadcasts.some(([ch, e]) => ch === 'claude:catalog' && e.catalog.commands.length));
  await until('the settings', () => of(t, key, 'settings').length > 0);
  assert.equal(seen.length, t.events.length);
  assert.deepEqual(of(t, key, 'tasks')[0].tasks, []);
  assert.equal(of(t, key, 'tasks').at(-1).tasks[0].id, 't1');
  assert.equal(of(t, key, 'message').find((e: any) => e.msg.subtype === 'sage_bash_output').msg.output, 'hello\n');
  const cat = t.broadcasts.filter(([ch]) => ch === 'claude:catalog').at(-1)![1];
  assert.equal(cat.cwd, cwd);
  assert.deepEqual(JSON.parse(JSON.stringify({ ...cat.catalog, skillFiles: undefined })), {
    commands: [
      { name: 'help', description: 'Help', argumentHint: '', aliases: ['h'], builtin: true },
      { name: 'x', description: '', argumentHint: '', aliases: [], builtin: false },
    ],
    skills: ['s1', 's2'],
    plugins: [
      { name: 'p', path: '/p' },
      { name: 'q', path: null },
    ],
    terminalSlash: ['/term'],
    live: true,
  });
  assert.deepEqual(t.claude.appliedOf(key), { probe: 'ok', ultracode: true, available: true, perTaskStop: true, origin: true });
  assert.equal(t.claude.appliedOf('claude:nobody'), null);
  assert.equal(t.claude.scheduled(key), 2);
  assert.equal(t.claude.scheduled('claude:nobody'), 0);
  assert.equal(t.claude.ownBusy(key), false);
  assert.equal(t.claude.turnApi.isLive(key), true);
  // the catalog a live session reported is what the folder shows
  assert.equal(await t.call('claude:catalog', bin, cwd, null), cat.catalog);

  // commands_changed replaces the commands; a second init doesn't ask for them again
  const q = lastQuery();
  q.push(
    { type: 'system', subtype: 'commands_changed' },
    {
      type: 'system',
      subtype: 'init',
      skills: ['s1', 's2'],
      plugins: [{ name: 'p', path: '/p' }, { name: 'q' }],
      terminal_slash_commands: ['/term'],
    },
  );
  await until('commands cleared', () => t.broadcasts.filter(([ch]) => ch === 'claude:catalog').at(-1)![1].catalog.commands.length === 0);
  await flush();
  assert.equal(q.calls.filter((c) => c[0] === 'getSettings').length, 1);
  await t.call('claude:control', key, 'close');
});

test('settings are read once per process: a CLI without getSettings, one where it fails and one with nothing applied', async () => {
  const t = load();
  const cases: [string, (q: any) => void, any][] = [
    [
      'missing',
      (q) => ((q.getSettings = undefined), (q.stopTask = undefined)),
      { probe: 'missing', ultracode: false, available: false, perTaskStop: false },
    ],
    [
      'failed',
      (q) => (q.getSettings = async () => Promise.reject(new Error('nope'))),
      { probe: 'failed', ultracode: false, available: false, perTaskStop: true },
    ],
    [
      'empty',
      (q) => (q.getSettings = async () => null),
      { probe: 'ok', ultracode: false, available: true, perTaskStop: true, origin: false },
    ],
    [
      'unavailable',
      (q) => (q.getSettings = async () => ({ applied: { ultracodeAvailable: false } })),
      { probe: 'ok', ultracode: false, available: false, perTaskStop: true, origin: false },
    ],
  ];
  for (const [name, patch, expect] of cases) {
    const key = `claude:settings-${name}`;
    fakes.onQuery = (q: any) => {
      patch(q);
      q.reply = () => [{ type: 'system', subtype: 'init' }, { type: 'result' }];
    };
    await t.claude.send(key, { bin, sessionId: `settings-${name}`, ephemeral: true }, user('hi'));
    await until(`${name} settings`, () => t.claude.appliedOf(key) !== null);
    assert.deepEqual(t.claude.appliedOf(key), expect, name);
    await t.call('claude:control', key, 'close');
  }
});

test('controls reach the live CLI; unknown ones throw and a chat without a process gets null', async () => {
  const t = load();
  const controlled: any[] = [];
  const u = load({ hooks: { onControl: (...a: any[]) => controlled.push(a) } });
  const key = 'claude:ctl';
  fakes.onQuery = (q: any) => {
    q.reply = () => [
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'b1', task_type: 'local_agent', description: 'x' }, { task_id: 'b2' }, {}],
      },
      { type: 'result' },
    ];
    q.stopTask = async (id: string) => {
      q.calls.push(['stopTask', id]);
      if (id === 'b2') throw new Error('already done');
    };
  };
  await u.claude.send(key, { bin, sessionId: 'ctl', ephemeral: true, permission: 'plan', basePermission: 'read-only' }, user('hi'));
  const q = lastQuery();
  assert.deepEqual(q.options.allowedTools, ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'NotebookRead']);
  assert.equal(q.options.permissionMode, 'plan');
  await until('the tasks', () => of(u, key, 'tasks').some((e: any) => e.tasks.length === 2));
  const c = (m: string, a?: any) => u.call('claude:control', key, m, a);
  assert.equal(u.claude.scheduled(key), 0);
  assert.equal(await c('interrupt'), 'interrupted');
  await c('setModel', '');
  await c('setModel', 'opus');
  await c('setPermissionMode', 'plan');
  await c('setPermissionMode', 'full-access');
  await c('setPermissionMode', 'auto-review');
  await c('stopTask', 5);
  assert.deepEqual(await c('contextUsage'), { used: 1 });
  await c('contextUsage', { detail: 'full' });
  assert.deepEqual(await c('mcpStatus'), [{ name: 'm', status: 'connected', extra: 1 }]);
  await c('toggleMcp', { name: 'm', enabled: 1 });
  await c('toggleMcp');
  assert.equal(await c('stopAllTasks'), true);
  await assert.rejects(c('bogus'), /Unknown control bogus/);
  assert.deepEqual(
    q.calls.filter((x) => x[0] !== 'getSettings' && x[0] !== 'supportedCommands'),
    [
      ['interrupt'],
      ['setModel', undefined],
      ['setModel', 'opus'],
      ['setPermissionMode', 'plan'],
      ['setPermissionMode', 'bypassPermissions'],
      ['setPermissionMode', 'auto'],
      ['stopTask', '5'],
      ['getContextUsage', { detail: 'summary' }],
      ['getContextUsage', { detail: 'full' }],
      ['mcpServerStatus'],
      ['toggleMcpServer', 'm', true],
      ['toggleMcpServer', 'undefined', false],
      ['stopTask', 'b1'],
      ['stopTask', 'b2'],
    ],
  );
  assert.equal(controlled.length, 14);
  // flag settings: an effort change keeps the ultracode getSettings reports; an explicit one is remembered
  await c('applyFlagSettings', { effortLevel: 'high' });
  assert.deepEqual(q.calls.filter((x) => x[0] === 'applyFlagSettings').at(-1), [
    'applyFlagSettings',
    { effortLevel: 'high', ultracode: true },
  ]);
  await c('applyFlagSettings', { ultracode: null });
  await c('applyFlagSettings', null);
  await c('applyFlagSettings', { ultracode: false });
  await c('applyFlagSettings', { effortLevel: 'low' });
  assert.deepEqual(
    q.calls
      .filter((x) => x[0] === 'applyFlagSettings')
      .slice(1)
      .map((x) => x[1]),
    [{ ultracode: null }, {}, { ultracode: false }, { effortLevel: 'low', ultracode: false }],
  );
  // closing tolerates a process that already went away
  q.close = () => {
    throw new Error('gone');
  };
  assert.equal(await c('close'), true);
  assert.equal(await t.call('claude:control', key, 'interrupt'), null);
  assert.equal(u.claude.turnApi.isLive(key), false);
});

test('permission cards carry the request, can be answered once, and are cancelled with their signal', async () => {
  const answered: string[] = [];
  const t = load({ hooks: { onPermission: (id: string) => answered.push(id) } });
  const key = 'claude:perm';
  await t.claude.send(key, { bin, sessionId: 'perm', ephemeral: true }, user('hi'));
  const q = lastQuery();
  const ask = q.options.canUseTool(
    'Bash',
    { command: 'ls' },
    { toolUseID: 'tu1', suggestions: [{ type: 'x' }], blockedPath: '/b', title: 'T', description: 'D', decisionReason: 'R' },
  );
  const card = of(t, key, 'permission').at(-1);
  assert.deepEqual(
    { ...card, requestId: undefined },
    {
      key,
      kind: 'permission',
      requestId: undefined,
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseID: 'tu1',
      agentID: null,
      displayName: null,
      suggestions: [{ type: 'x' }],
      blockedPath: '/b',
      title: 'T',
      description: 'D',
      decisionReason: 'R',
    },
  );
  assert.equal(await t.call('claude:permission', card.requestId, { behavior: 'allow', updatedInput: {} }), true);
  assert.deepEqual(await ask, { behavior: 'allow', updatedInput: {} });
  assert.equal(await t.call('claude:permission', card.requestId, { behavior: 'deny' }), false);
  assert.deepEqual(answered, [card.requestId, card.requestId]);

  // no options: every optional field is null
  const bare = q.options.canUseTool('Edit', {});
  const bareCard = of(t, key, 'permission').at(-1);
  assert.deepEqual(
    [bareCard.toolUseID, bareCard.suggestions, bareCard.blockedPath, bareCard.title, bareCard.description, bareCard.decisionReason],
    [null, null, null, null, null, null],
  );
  t.call('claude:permission', bareCard.requestId, { behavior: 'deny', message: 'no' });
  assert.deepEqual(await bare, { behavior: 'deny', message: 'no' });

  // cancelled by the CLI: denied, and the window drops the card; a late abort after an answer does nothing
  const ac = new AbortController();
  const cancelled = q.options.canUseTool('Write', {}, { signal: ac.signal });
  const id = of(t, key, 'permission').at(-1).requestId;
  ac.abort();
  assert.deepEqual(await cancelled, { behavior: 'deny', message: 'Cancelled' });
  assert.deepEqual(
    of(t, key, 'permissionCancelled').map((e: any) => e.requestId),
    [id],
  );
  const ac2 = new AbortController();
  const done = q.options.canUseTool('Write', {}, { signal: ac2.signal });
  t.call('claude:permission', of(t, key, 'permission').at(-1).requestId, { behavior: 'allow' });
  await done;
  ac2.abort();
  assert.equal(of(t, key, 'permissionCancelled').length, 1);

  // elicitations: accepted with content, accepted without, unanswered (declined) and cancelled
  const elicit = (req: any, o?: any) => q.options.onElicitation(req, o);
  const e1 = elicit({ serverName: 's', message: 'm', mode: 'url', url: 'https://x', requestedSchema: { a: 1 }, title: 'T' });
  const card1 = of(t, key, 'elicitation').at(-1);
  assert.deepEqual(
    [card1.serverName, card1.message, card1.mode, card1.url, card1.requestedSchema, card1.title],
    ['s', 'm', 'url', 'https://x', { a: 1 }, 'T'],
  );
  t.call('claude:permission', card1.requestId, { action: 'accept', content: { a: 2 } });
  assert.deepEqual(await e1, { action: 'accept', content: { a: 2 } });
  const e2 = elicit({ serverName: 's', message: 'm' });
  const card2 = of(t, key, 'elicitation').at(-1);
  assert.deepEqual([card2.mode, card2.url, card2.requestedSchema, card2.title], ['form', null, null, null]);
  t.call('claude:permission', card2.requestId, { action: 'accept' });
  assert.deepEqual(await e2, { action: 'accept' });
  const e3 = elicit({ serverName: 's', message: 'm' });
  t.call('claude:permission', of(t, key, 'elicitation').at(-1).requestId, null);
  assert.deepEqual(await e3, { action: 'decline' });
  const ac3 = new AbortController();
  const e4 = elicit({ serverName: 's', message: 'm' }, { signal: ac3.signal });
  ac3.abort();
  assert.deepEqual(await e4, { action: 'cancel' });
  const ac4 = new AbortController();
  const e5 = elicit({ serverName: 's', message: 'm' }, { signal: ac4.signal });
  t.call('claude:permission', of(t, key, 'elicitation').at(-1).requestId, { action: 'decline' });
  await e5;
  ac4.abort();
  assert.equal(of(t, key, 'permissionCancelled').length, 2);

  // an open card is denied when the process ends
  const open = q.options.canUseTool('Bash', {});
  await t.call('claude:control', key, 'close');
  assert.deepEqual(await open, { behavior: 'deny', message: 'Session closed' });
});

test('MoPilot’s tools: a server per process, allowed without a card, ended with the process; off or empty means none', async () => {
  const t = load();
  const opened: any[] = [];
  const ended: string[] = [];
  let tools = [{ name: 'look', description: 'Look', inputSchema: { type: 'object', properties: {} }, policy: 'observe' }];
  let enabled: any = () => true;
  const sageTools = {
    get enabled() {
      return enabled;
    },
    registry: { list: () => tools, invoke: async () => ({ ok: true }) },
    sessions: {
      open: (k: string, owner: any) => (opened.push([k, owner]), { serverName: 'sage_0123456789ab' }),
      end: (k: string) => ended.push(k),
    },
  };
  t.claude.setTools(sageTools);
  await t.claude.send('claude:tools', { bin, sessionId: 'tools', chatId: 'chat-1', ephemeral: true, permission: 'read-only' }, user('hi'));
  const q = lastQuery();
  assert.deepEqual(opened[0][1], { chatId: 'chat-1', segmentId: 'claude:tools', shared: 'claude' });
  assert.match(opened[0][0], /^claude:claude:tools:/);
  assert.ok(q.options.mcpServers.sage_0123456789ab);
  assert.ok(q.options.allowedTools.includes('mcp__sage_0123456789ab__look'));
  assert.deepEqual(await q.options.canUseTool('mcp__sage_0123456789ab__look', { a: 1 }, {}), { behavior: 'allow', updatedInput: { a: 1 } });
  assert.equal(of(t, 'claude:tools', 'permission').length, 0);
  await t.call('claude:control', 'claude:tools', 'close');
  await until('the server ended', () => ended.length === 1);
  assert.equal(ended[0], opened[0][0]);

  // no tools to give: the server is ended right away; without a chat id the owner is the key's chat, looked
  // up at each call (here no chat claims the key, so the key itself)
  tools = [];
  await t.claude.send('claude:empty', { bin, ephemeral: true }, user('hi'));
  assert.equal(opened[1][1].segmentId, 'claude:empty');
  assert.equal(opened[1][1].chatId(), 'claude:empty');
  // main's lookup (controller.chatOf) answers once the chat records the session; an unknown key stays itself
  t.claude.setChatOf((k: string) => (k === 'claude:empty' ? 'chat-9' : null));
  assert.equal(opened[1][1].chatId(), 'chat-9');
  t.claude.setChatOf(() => null);
  assert.equal(opened[1][1].chatId(), 'claude:empty');
  t.claude.setChatOf((k: string) => k);
  assert.equal(lastQuery().options.mcpServers, undefined);
  assert.equal(ended.length, 2);
  await t.call('claude:control', 'claude:empty', 'close');
  // switched off remotely; no enabled() switch at all means on
  enabled = () => false;
  await t.claude.send('claude:off', { bin, ephemeral: true }, user('hi'));
  assert.equal(opened.length, 2);
  await t.call('claude:control', 'claude:off', 'close');
  enabled = undefined;
  tools = [{ name: 'act', description: 'Act', inputSchema: { type: 'object', properties: {} }, policy: 'act' }];
  await t.claude.send('claude:on', { bin, ephemeral: true }, user('hi'));
  assert.equal(opened.length, 3);
  assert.ok(lastQuery().options.mcpServers.sage_0123456789ab);
  await t.call('claude:control', 'claude:on', 'close');
});

test('side chats fork unpersisted; live output can be turned off; a stream that fails reports its stderr', async () => {
  const t = load();
  process.env.SAGE_CLAUDE_LIVE_OUTPUT = '0';
  try {
    fakes.onQuery = (q: any) => {
      q.getTaskOutput = async () => ({ output: 'never' });
      q.reply = () => [
        { type: 'system', subtype: 'task_started', task_id: 't', task_type: 'local_bash', tool_use_id: 'tu' },
        { type: 'result' },
      ];
    };
    const r = await t.claude.send('claude:side', { bin, forkFrom: 'parent-sid', sessionId: 'side' }, user('hi'));
    assert.deepEqual(r, { elsewhere: [] });
    const q = lastQuery();
    assert.deepEqual(
      [q.options.resume, q.options.forkSession, q.options.persistSession, q.options.sessionId],
      ['parent-sid', true, false, undefined],
    );
    await until('the result', () => of(t, 'claude:side', 'message').some((e: any) => e.msg.type === 'result'));
    await flush();
    assert.equal(of(t, 'claude:side', 'message').filter((e: any) => e.msg.subtype === 'sage_bash_output').length, 0);
    // side chats outlive a billing change
    await t.call('claude:setCloudEnv', true);
    assert.equal(t.claude.turnApi.isLive('claude:side'), true);
    await t.call('claude:control', 'claude:side', 'close');
  } finally {
    delete process.env.SAGE_CLAUDE_LIVE_OUTPUT;
  }

  // carrying the account folder back fails: the process still ends cleanly
  t.claude.identity.accounts().syncBack = () => {
    throw new Error('disk full');
  };
  await t.claude.send('claude:fail', { bin, sessionId: 'fail', ephemeral: true }, user('hi'));
  const q = lastQuery();
  const chunks = Array.from({ length: 105 }, (_, i) => `line ${i}: ${'x'.repeat(40)}\n`);
  for (const chunk of chunks) q.options.stderr(chunk);
  q.end(new Error('CLI crashed'));
  await until('the error', () => of(t, 'claude:fail', 'error').length === 1);
  const err = of(t, 'claude:fail', 'error')[0];
  assert.equal(err.error, 'CLI crashed');
  assert.equal(err.stderr, chunks.join('').slice(-2000));
  await t.claude.send('claude:fail2', { bin, sessionId: 'fail2', ephemeral: true }, user('hi'));
  lastQuery().end('plain failure');
  await until('the second error', () => of(t, 'claude:fail2', 'error').length === 1);
  assert.equal(of(t, 'claude:fail2', 'error')[0].error, 'plain failure');
  assert.equal(of(t, 'claude:fail2', 'closed').length, 0);
});

test('a session on an unregistered module runs without accounts', async () => {
  const t = load({ register: false });
  fs.writeFileSync(path.join(t.userData, 'claude-api-key'), 'sk-1');
  fs.writeFileSync(path.join(t.userData, 'claude-auth-mode'), 'apiKey');
  const cwd = fs.mkdtempSync(path.join(tmp, 'bare-'));
  fakes.onQuery = (q: any) => (q.reply = () => [{ type: 'system', subtype: 'init', skills: ['k'] }, { type: 'result' }]);
  await t.claude.send('claude:bare', { bin, sessionId: 'bare', ephemeral: true, cwd, fast: true }, user('hi'));
  const q = lastQuery();
  assert.equal(q.options.env.ANTHROPIC_API_KEY, 'sk-1');
  assert.deepEqual([q.options.settings.fastMode, new Set(Object.values(q.options.settings.skillOverrides))], [true, new Set(['off'])]);
  await until('the reply', () => q.inputs.length === 1);
  q.end();
  await until('the session ended', () => !t.claude.turnApi.isLive('claude:bare'));
});

test('a queued message goes to the running process; the chat permission is re-read on each send', async () => {
  const t = load();
  const key = 'claude:queue';
  fakes.onQuery = (q: any) => (q.reply = null);
  await t.claude.send(key, { bin, sessionId: 'queue', ephemeral: true, permission: 'default' }, user('one'), undefined, {
    human: true,
    uuid: 'u-1',
  });
  const q = lastQuery();
  assert.equal(t.claude.ownBusy(key), true);
  await t.claude.send(key, { bin, sessionId: 'queue', ephemeral: true, account: 'other' }, user('two'), 'next');
  await t.claude.send(
    key,
    { bin, sessionId: 'queue', ephemeral: true, permission: 'plan', basePermission: 'full-access' },
    user('three'),
    'now',
  );
  await until('three inputs', () => q.inputs.length === 3);
  assert.equal(fakes.queries.at(-1), q);
  assert.deepEqual(
    q.inputs.map((m: any) => [m.priority, m.origin?.kind ?? null]),
    [
      [undefined, 'human'],
      ['next', null],
      ['now', null],
    ],
  );
  assert.equal(q.inputs[0].uuid, 'u-1');
  // the plan approved later returns to full access
  const ask = q.options.canUseTool('ExitPlanMode', {});
  t.call('claude:permission', of(t, key, 'permission').at(-1).requestId, { behavior: 'allow', updatedInput: {} });
  assert.deepEqual((await ask).updatedPermissions, [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }]);
  await t.call('claude:control', key, 'close');
});

test('a prompt sent into the running turn keeps it busy until its own result; an interrupt owes just one', async () => {
  const t = load();
  const key = 'claude:steer';
  const results = () => of(t, key, 'message').filter((e: any) => e.msg.type === 'result').length;
  fakes.onQuery = (q: any) => (q.reply = null);
  await t.claude.send(key, { bin, sessionId: 'steer', ephemeral: true }, user('one'));
  const q = lastQuery();
  await t.claude.send(key, { bin, sessionId: 'steer', ephemeral: true }, user('two'), 'now');
  await until('two inputs', () => q.inputs.length === 2);
  // the first prompt's result: the steered one is still running, so its writes are Sage's own
  q.push({ type: 'result', subtype: 'success' });
  await until('the first result', () => results() === 1);
  assert.equal(t.claude.ownBusy(key), true);
  q.push({ type: 'result', subtype: 'success' });
  await until('the second result', () => results() === 2);
  assert.equal(t.claude.ownBusy(key), false);
  // the CLI drops queued prompts on interrupt: the next result ends the turn
  await t.claude.send(key, { bin, sessionId: 'steer', ephemeral: true }, user('three'));
  await t.claude.send(key, { bin, sessionId: 'steer', ephemeral: true }, user('four'), 'next');
  await t.call('claude:control', key, 'interrupt');
  q.push({ type: 'result', subtype: 'error_during_execution' });
  await until('the interrupted result', () => results() === 3);
  assert.equal(t.claude.ownBusy(key), false);
  await t.call('claude:control', key, 'close');
});

test('control backgroundTasks sends the foreground work, or the one tool call it names, to the background', async () => {
  const t = load();
  const key = 'claude:bg';
  fakes.onQuery = (q: any) => (q.reply = null);
  await t.claude.send(key, { bin, sessionId: 'bg', ephemeral: true }, user('run it'));
  const q = lastQuery();
  assert.equal(await t.call('claude:control', key, 'backgroundTasks'), true);
  assert.equal(await t.call('claude:control', key, 'backgroundTasks', 'toolu_1'), true);
  assert.deepEqual(
    q.calls.filter((x: any[]) => x[0] === 'backgroundTasks'),
    [
      ['backgroundTasks', undefined],
      ['backgroundTasks', 'toolu_1'],
    ],
  );
  await t.call('claude:control', key, 'close');
});

test("a turn the CLI starts itself (a background task's wake-up) is Sage's own until its result, so it is not another app's write", async () => {
  const t = load();
  const key = 'claude:woken';
  fakes.onQuery = (q: any) => (q.reply = null);
  await t.claude.send(key, { bin, sessionId: 'woken', ephemeral: true }, user('start a background agent'));
  const q = lastQuery();
  q.push({ type: 'result', subtype: 'success' });
  await until('the first result', () => !t.claude.ownBusy(key));
  // the agent finished and the CLI answers on its own: assistant output with no prompt owed
  q.push({ type: 'assistant', uuid: 'w1', message: { id: 'm1', content: [{ type: 'text', text: 'The agent is done.' }] } });
  await until('the wake-up', () => t.claude.ownBusy(key));
  q.push({ type: 'result', subtype: 'success' });
  await until('its result', () => !t.claude.ownBusy(key));
  // streamed partials count too; an idle session with no output owes nothing
  q.push({ type: 'stream_event', event: { type: 'message_start' } });
  await until('a streamed wake-up', () => t.claude.ownBusy(key));
  q.push({ type: 'result', subtype: 'success' });
  await until('and its result', () => !t.claude.ownBusy(key));
  assert.equal(t.claude.ownBusy('claude:never-started'), false);
  await t.call('claude:control', key, 'close');
});

test('another app writing the transcript between turns restarts the CLI from disk; its own writes do not', async () => {
  const t = load();
  const sid = '22222222-2222-4222-8222-222222222222';
  const key = `claude:${sid}`;
  transcript(sid, [{ type: 'user', uuid: 'u0', message: { content: 'old' } }]);
  let parent = 'u0';
  fakes.onQuery = (q: any) => {
    q.reply = (m: any) => {
      appendRows(sid, [
        { type: 'user', uuid: m.uuid, parentUuid: parent, message: { content: 'x' } },
        { type: 'assistant', uuid: `a-${m.uuid}`, parentUuid: m.uuid, message: { content: [] } },
      ]);
      parent = `a-${m.uuid}`;
      return [
        { type: 'system', subtype: 'init' },
        { type: 'assistant', uuid: `a-${m.uuid}`, message: { content: [] } },
        { type: 'result' },
      ];
    };
  };
  fakes.run = () => ({ err: new Error('no ps') });
  await t.claude.send(key, { bin, sessionId: sid, resume: true }, user('one'), undefined, { uuid: 'p1' });
  const first = lastQuery();
  assert.equal(first.options.resume, sid);
  await until('the first result', () => of(t, key, 'message').some((e: any) => e.msg.type === 'result'));
  // right after the result (tip not settled yet): its own writes, the same process
  await t.claude.send(key, { bin, sessionId: sid, resume: true }, user('two'), undefined, { uuid: 'p2' });
  assert.equal(lastQuery(), first);
  await until('the second result', () => of(t, key, 'message').filter((e: any) => e.msg.type === 'result').length === 2);
  await new Promise((r) => setTimeout(r, 300));
  // another app appends a prompt after this process's tip
  appendRows(sid, [{ type: 'user', uuid: 'x1', parentUuid: parent, message: { content: 'from the CLI' } }]);
  parent = 'x1';
  await t.claude.send(key, { bin, sessionId: sid, resume: true }, user('three'), undefined, { uuid: 'p3' });
  assert.notEqual(lastQuery(), first);
  assert.ok(first.closed);
  assert.equal(of(t, key, 'closed').length, 0);
  await t.call('claude:control', key, 'close');
});

test('a process whose transcript went behind during its own turn restarts at the next send', async () => {
  const t = load();
  const sid = '33333333-3333-4333-8333-333333333333';
  const key = `claude:${sid}`;
  transcript(sid, [{ type: 'user', uuid: 'u0', message: { content: 'old' } }]);
  fakes.onQuery = (q: any) => {
    q.reply = (m: any) => {
      // someone else's prompt and its answer land right after this turn's own
      appendRows(sid, [
        { type: 'user', uuid: m.uuid, parentUuid: 'u0', message: { content: 'x' } },
        { type: 'assistant', uuid: `a-${m.uuid}`, parentUuid: m.uuid, message: { content: [] } },
        { type: 'user', uuid: 'y1', parentUuid: `a-${m.uuid}`, message: { content: 'typed elsewhere' } },
        { type: 'assistant', uuid: 'z1', parentUuid: 'y1', message: { content: [] } },
      ]);
      return [{ type: 'assistant', uuid: `a-${m.uuid}`, message: { content: [] } }, { type: 'result' }];
    };
  };
  await t.claude.send(key, { bin, sessionId: sid }, user('one'));
  const first = lastQuery();
  assert.equal(first.options.sessionId, sid);
  await until('the result', () => of(t, key, 'message').some((e: any) => e.msg.type === 'result'));
  await new Promise((r) => setTimeout(r, 300));
  await t.claude.send(key, { bin, sessionId: sid }, user('two'));
  assert.notEqual(lastQuery(), first);
  await t.call('claude:control', key, 'close');
});

test('edit-and-resend: busy chats wait, messages with nothing before them cannot rewind, a refused rewind keeps the process', async () => {
  const t = load();
  const sid = '44444444-4444-4444-8444-444444444444';
  const key = `claude:${sid}`;
  transcript(sid, [
    { type: 'user', uuid: 'm1', parentUuid: null },
    { type: 'file-history-snapshot', messageId: 'm1' },
    { type: 'user', uuid: 'm2', parentUuid: 'a1' },
    { type: 'file-history-snapshot', messageId: 'm2' },
  ]);
  fakes.onQuery = (q: any) => (q.reply = null);
  await t.claude.send(key, { bin, sessionId: sid, resume: true }, user('busy'));
  await assert.rejects(t.call('claude:rewind', key, {}, 'm2', true), /Wait for this turn to finish/);
  await t.call('claude:control', key, 'close');

  fakes.onQuery = (q: any) => (q.rewindFiles = async () => ({ canRewind: false, error: 'no' }));
  assert.deepEqual(await t.call('claude:rewind', key, { bin, sessionId: sid }, 'm1', false), {
    canRewind: false,
    error: 'This message has nothing before it to go back to',
  });
  const q = lastQuery();
  assert.equal(q.options.resume, sid);
  assert.deepEqual(await t.call('claude:rewind', key, { bin, sessionId: sid }, 'm2', false), { canRewind: false, error: 'no' });
  assert.equal(lastQuery(), q);
  assert.equal(t.claude.turnApi.isLive(key), true);
  await t.call('claude:control', key, 'close');

  // an unpersisted chat has no transcript to rewind
  await t.claude.send('claude:eph', { bin, sessionId: 'eph', ephemeral: true }, user('hi'));
  await until('the reply', () => !t.claude.ownBusy('claude:eph'));
  assert.equal((await t.call('claude:rewind', 'claude:eph', {}, 'm2', true)).canRewind, false);
  await t.call('claude:control', 'claude:eph', 'close');
});

test('the catalog for a folder no session ran in is prefetched, with skills read from disk', async () => {
  const t = load();
  const cwd = fs.mkdtempSync(path.join(tmp, 'cat-'));
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'home-skill'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'home-skill', 'SKILL.md'), '---\nname: home-skill\n---\n');
  fs.mkdirSync(path.join(cwd, '.claude', 'skills', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'skills', 'proj', 'SKILL.md'), 'no front matter');
  fakes.onQuery = (q: any) => (q.initializationResult = async () => ({ commands: [{ name: 'review', description: 'Review' }] }));
  const cat = await t.call('claude:catalog', bin, cwd, null);
  assert.deepEqual(JSON.parse(JSON.stringify({ ...cat, skillFiles: undefined })), {
    commands: [{ name: 'review', description: 'Review', argumentHint: '', aliases: [], builtin: false }],
    skills: ['home-skill', 'proj'],
    plugins: [],
    terminalSlash: null,
    live: false,
  });
  assert.equal(lastQuery().options.cwd, cwd);
  // the same answer again changes nothing and isn't broadcast twice
  const sent = t.broadcasts.filter(([ch]) => ch === 'claude:catalog').length;
  assert.equal(await t.call('claude:catalog', bin, cwd, null), cat);
  assert.equal(t.broadcasts.filter(([ch]) => ch === 'claude:catalog').length, sent);

  // an account's own config folder holds its skills
  const cfg = fs.mkdtempSync(path.join(tmp, 'cfg-'));
  fs.mkdirSync(path.join(cfg, 'skills', 'cfg-skill'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'skills', 'cfg-skill', 'SKILL.md'), '');
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    fakes.onQuery = (q: any) => (q.initializationResult = async () => ({}));
    const other = await t.call('claude:catalog', bin, undefined, 'acct');
    assert.deepEqual(other.skills, ['cfg-skill']);
    assert.equal(lastQuery().options.cwd, undefined);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('extras lists commands and MCP servers; a server list that fails or stalls is reported as unread, a stalled init fails', async () => {
  const t = load();
  fakes.onQuery = (q: any) => {
    q.initializationResult = async () => ({ commands: [{ name: 'a' }] });
    q.close = () => {
      throw new Error('gone');
    };
  };
  assert.deepEqual(await t.call('claude:extras', bin, path.join(tmp, 'missing-dir'), null), {
    commands: [{ name: 'a', description: '', argumentHint: '', aliases: [], builtin: false }],
    mcp: [{ name: 'm', status: 'connected' }],
  });
  assert.equal(lastQuery().options.cwd, undefined);
  // a path that isn't installed is passed as given
  fakes.onQuery = (q: any) => (q.mcpServerStatus = async () => Promise.reject(new Error('x')));
  const missing = path.join(tmp, 'not-installed');
  assert.deepEqual(await t.call('claude:extras', missing, null, null), { commands: [], mcp: [], mcpError: 'x' });
  fakes.onQuery = (q: any) => (q.mcpServerStatus = async () => null);
  assert.match((await t.call('claude:extras', bin, null, null)).mcpError, /invalid MCP server list/);

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    fakes.onQuery = (q: any) => (q.mcpServerStatus = () => new Promise(() => {}));
    const before = fakes.queries.length;
    let p = t.call('claude:extras', bin, null, null);
    await waitFor(() => fakes.queries.length !== before, 'the first extras query', { step: flush });
    await flush();
    mock.timers.tick(10000);
    assert.deepEqual(await p, { commands: [], mcp: [], mcpError: 'Timed out' });
    fakes.onQuery = (q: any) => (q.initializationResult = () => new Promise(() => {}));
    p = t.call('claude:extras', bin, null, null);
    await waitFor(() => fakes.queries.length !== before + 1, 'the second extras query', { step: flush });
    mock.timers.tick(20000);
    await assert.rejects(p, /Timed out/);
  } finally {
    mock.timers.reset();
  }
});

test('summaries and titles: one unpersisted turn of text, nothing when no CLI is installed', async () => {
  const t = load();
  const cwd = fs.mkdtempSync(path.join(tmp, 'sum-'));
  await assert.rejects(t.claude.summarize('sid', cwd, 'p', path.join(tmp, 'nope')), /not installed/);
  fakes.onQuery = (q: any) =>
    q.push(
      {
        type: 'assistant',
        message: {
          content: [null, 42, [], { type: 'text', text: ' Summary ' }, { type: 'thinking', text: 'no' }],
        },
      },
      { type: 'assistant', message: {} },
      { type: 'user' },
      { type: 'result' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'after' }] } },
    );
  assert.equal(await t.claude.summarize('sid', cwd, 'p', bin, 'acct'), 'Summary');
  let q = lastQuery();
  assert.deepEqual(
    [q.options.resume, q.options.forkSession, q.options.persistSession, q.options.cwd, q.prompt],
    ['sid', true, false, cwd, 'p'],
  );
  fakes.onQuery = (q: any) => (q.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'Rest' }] } }), q.end());
  assert.equal(await t.claude.summarize('sid', path.join(tmp, 'gone'), 'p', bin), 'Rest');
  assert.equal(lastQuery().options.cwd, home);

  fakes.onQuery = (q: any) =>
    q.push({ type: 'assistant', message: { content: [null, 42, [], { type: 'text', text: 'Fix the bug' }] } }, { type: 'result' });
  assert.equal(await t.claude.turnApi.title('fix it', cwd, bin, undefined), 'Fix the bug');
  q = lastQuery();
  assert.deepEqual([q.options.model, q.options.cwd, q.options.persistSession], ['haiku', cwd, false]);
  fakes.onQuery = (q: any) => q.push({ type: 'assistant', message: {} }, { type: 'result' });
  assert.equal(await t.claude.turnApi.title('x', null, bin, 'acct'), null);
  fakes.onQuery = (q: any) => q.end();
  assert.equal(await t.claude.turnApi.title('x', path.join(tmp, 'gone'), bin), null);
  assert.equal(await t.claude.turnApi.title('x', null, path.join(tmp, 'nope')), null);
  fakes.onQuery = (q: any) => q.end(new Error('boom'));
  await assert.rejects(t.claude.turnApi.title('x', null, bin), /boom/);
});

test('the reaper closes idle chats after an hour, never one with work, a card, a turn or that is kept', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  try {
    const t = load();
    const keys = ['idle', 'kept', 'busy', 'card', 'cron'].map((k) => `claude:reap-${k}`);
    for (const key of keys) {
      fakes.onQuery = (q: any) => {
        if (key.endsWith('busy')) q.reply = null;
        if (key.endsWith('cron'))
          q.reply = () => [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'CronCreate' }] } }, { type: 'result' }];
      };
      await t.claude.send(key, { bin, sessionId: key.slice(7), ...(key.endsWith('kept') ? { ephemeral: true } : {}) }, user('hi'));
      if (key.endsWith('card')) lastQuery().options.canUseTool('Bash', {});
    }
    for (let i = 0; i < 20; i++) await flush();
    mock.timers.tick(t.claude.governor.idleLimit({}) - 60 * 1000);
    assert.equal(keys.filter((k) => t.claude.turnApi.isLive(k)).length, 5);
    mock.timers.tick(2 * 60 * 1000 + 1);
    assert.deepEqual(
      keys.filter((k) => t.claude.turnApi.isLive(k)),
      keys.slice(1),
    );
    t.claude.closeAll();
    assert.deepEqual(
      keys.filter((k) => t.claude.turnApi.isLive(k)),
      [],
    );
  } finally {
    mock.timers.reset();
  }
});
