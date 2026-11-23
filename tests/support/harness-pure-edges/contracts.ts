// Harness metadata, capability contracts and fallback edge cases.
import {
  test,
  assert,
  fx,
  reset,
  approvals,
  caps,
  ct,
  usage,
  catalog,
  compatCodex,
  tr,
  commands,
  entries,
  instructions,
  registry,
  acpSessions,
  plan,
  types,
  ownership,
  shell,
  compat,
} from './fixture.ts';

export function registerContracts() {
  test('approval cards from requests with missing fields', () => {
    const card = (method: string, params?: any): { params: any } => approvals.toRequest('c', { id: 1, method, params }, '/w', 5)!;
    const bash = card('claude/permission', { toolName: 'Bash' });
    assert.deepEqual(
      [bash.params.command, bash.params.itemId, bash.params.reason, bash.params._claude.suggestions],
      ['', null, null, null],
    );
    assert.equal(card('claude/permission', { toolName: 'Bash', decisionReason: 'why', input: { command: 'ls' } }).params.reason, 'why');
    assert.equal(card('claude/permission', { toolName: 'Write', blockedPath: '/etc' }).params.grantRoot, '/etc');
    assert.equal(card('claude/permission', { toolName: 'Edit' }).params.grantRoot, null);
    assert.deepEqual(card('claude/permission', { toolName: 'AskUserQuestion' }).params.questions, []);
    assert.deepEqual(
      card('claude/permission', { toolName: 'AskUserQuestion', input: { questions: [{ question: 'Q?' }] } }).params.questions[0],
      { id: '0', header: null, question: 'Q?', options: [], isOther: true, isSecret: false, multiSelect: false },
    );
    assert.deepEqual(card('acp/permission').params, { threadId: 'c', turnId: null, toolCall: null, options: [] });
    assert.deepEqual(card('mcpServer/elicitation/request', { serverName: 's' }).params, { serverName: 's' });
    assert.equal(card('mcpServer/elicitation/request', { claude: true, serverName: 's' }).params._claude.toolName, '');
    assert.deepEqual(card('other/thing').params, {});
    assert.equal(approvals.toRequest('c', { id: 2, method: 'sage/computer', params: {} }, null, 0), null);
  });

  test('why text: known placeholders are filled, the feature capitalised at the start of a sentence', () => {
    assert.equal(typeof caps.whyText({ layer: 'harness', code: 'no.such.code' } as any), 'string');
    const text = caps.whyText({ layer: 'version', code: 'version.incompatible', fix: 'upgrade' } as any, {
      label: 'Codex',
      version: '1.0',
    });
    assert.match(text, /Codex 1\.0/);
    assert.doesNotMatch(text, /[{}]/);
  });

  test('Claude answers to elicitations, questions and approvals', () => {
    assert.deepEqual(ct.claudeAnswer('mcpServer/elicitation/request', {}, null), { action: 'decline' });
    assert.deepEqual(ct.claudeAnswer('mcpServer/elicitation/request', {}, { action: 'accept' }), { action: 'accept' });
    assert.deepEqual(ct.claudeAnswer('mcpServer/elicitation/request', {}, { action: 'accept', content: { a: 1 } }), {
      action: 'accept',
      content: { a: 1 },
    });
    // a question tool that asks nothing is allowed with no answers, as Claude Code's own card answers it
    assert.equal(ct.claudeAnswer('item/tool/requestUserInput', null, null).behavior, 'allow');
    assert.deepEqual(
      ct.claudeAnswer(
        'item/tool/requestUserInput',
        { questions: [{ question: 'A?' }, { question: 'B?' }] },
        { answers: { 0: { answers: ['x', 'y'] } } },
      )?.updatedInput?.answers,
      { 'A?': 'x, y' },
    );
    assert.equal(ct.claudeAnswer('x', {}, { decision: 'approved' }).behavior, 'allow');
    assert.equal(ct.claudeAnswer('x', {}, { decision: 'approved_for_session' }, null).updatedPermissions, undefined);
    assert.equal(ct.claudeAnswer('x', {}, { decision: { acceptWithExecpolicyAmendment: {} } }, [1])?.updatedPermissions?.[0], 1);
    assert.equal(ct.claudeAnswer('x', {}, { decision: 'cancel' }).message, 'The user cancelled this action.');
    assert.equal(ct.claudeAnswer('x', {}, { decision: 'cancel', reason: ' no ' }).message, 'The user cancelled this action: no');
    assert.equal(ct.claudeAnswer('x', {}, { decision: 'decline', reason: '  ' }).message, 'The user declined this action.');
    assert.equal(ct.claudeAnswer('x', {}, null).behavior, 'deny');
    assert.equal(ct.claudeModelFor('claude-opus-9', [{ id: 'sonnet' }] as any), 'claude-opus-9');
    assert.equal(ct.claudeModelFor('claude-opus-9', [{ id: 'opus' }] as any), 'opus');
    assert.equal(ct.claudeModelFor('gpt-x', [{ id: 'opus' }] as any), 'gpt-x');
  });

  test('usage readings merge by window; a failed read without an Error is reported as text', async () => {
    assert.equal(usage.mergeUsage(null, null), null);
    const prev = { windows: [{ label: '5h', usedPercent: 1, resetsAt: null }], at: 1 };
    assert.equal(usage.mergeUsage(prev as any, { windows: [], at: 2 } as any), prev);
    assert.deepEqual(usage.mergeUsage(null, { windows: [{ label: '5h', usedPercent: 2, resetsAt: null }], at: 3 } as any)!.windows, [
      { label: '5h', usedPercent: 2, resetsAt: null },
    ]);
    const fetches: any[] = [];
    const refresh = usage.createUsageRefresher({
      read: async () => {
        throw 'plain';
      },
      current: () => null,
      noteReading: () => {},
      noteFetch: (...a) => fetches.push(a),
    });
    await refresh('a');
    // the 4th argument is the account the answer names (none here)
    assert.deepEqual(fetches.at(-1), ['a', 'error', 'plain', undefined]);
    const r2 = usage.createUsageRefresher({
      read: async () => ({ state: 'success', text: '   ' }),
      current: () => null,
      noteReading: () => {},
      noteFetch: (...a) => fetches.push(a),
    });
    await r2('b');
    assert.deepEqual(fetches.at(-1), ['b', 'unavailable', 'Claude Code returned no usage data.', undefined]);
  });

  test('Codex plugins and skills: listed through the API; one skill per name, nearest project first', async () => {
    reset();
    fx.native.codex = { api: async (name: string, args: any[]) => [name, args] };
    assert.deepEqual(await catalog.listCodexPlugins(), ['pluginList', []]);
    assert.deepEqual(await catalog.listCodexSkills('/w'), ['skillList', ['/w', false]]);
    assert.deepEqual(await catalog.listCodexSkills('/w', true), ['skillList', ['/w', true]]);
    const skill = (name: string, scope: string, path: string, enabled?: boolean) => ({ name, scope, path, enabled });
    const res: any = {
      data: [
        {
          cwd: '/elsewhere',
          skills: [
            skill('a', 'user', '/home/.codex/skills/a/SKILL.md'),
            skill('a', 'repo', '/w/.codex/skills/a/SKILL.md'),
            skill('a', 'repo', '/w/sub/.agents/skills/a/SKILL.md'),
            skill('a', 'repo', '/w/x/skills/a/SKILL.md'),
            skill('b', 'system', '/s/b', false),
          ],
        },
      ],
    };
    const got = catalog.composerCodexSkills(res, '/w/sub/deep');
    assert.deepEqual(
      got.map((s) => s.path),
      ['/w/sub/.agents/skills/a/SKILL.md'],
    );
  });

  test('Codex version gate: missing versions and probes', () => {
    assert.match(compatCodex.incompatibleText({} as any), /Codex/);
    assert.equal(compatCodex.codexWhy(null, 'goal'), null);
    assert.equal(compatCodex.codexWhy({} as any, 'goal'), null);
    assert.equal(compatCodex.codexWhy({ probes: { 'codex.goals': false } } as any, 'goal')!.code, 'version.probeFailed');
    assert.equal(compatCodex.codexWhy({ probes: {} } as any, 'rename'), null);
    assert.equal(compatCodex.codexBlocked(null, 'goal'), null);
    assert.equal(typeof compatCodex.codexBlocked({ probes: { 'codex.goals': false } } as any, 'goal'), 'string');
  });

  test('Codex items: odd shapes are read safely', () => {
    assert.deepEqual(
      tr.presentItems([null as any, { type: 'exitedReviewMode' }, { type: 'agentMessage' }, { type: 'agentMessage', text: 'kept' }]),
      [null, { type: 'exitedReviewMode' }, { type: 'agentMessage', text: 'kept' }],
    );
    assert.equal(tr.turnCard([null, { type: 'exitedReviewMode' }], false, false), null);
    assert.deepEqual(tr.backgroundTerminals({ data: [{ processId: 1 }, null, { processId: null }] }), [
      { itemId: '', processId: '1', command: '', cwd: '', osPid: null },
    ]);
    assert.deepEqual(tr.backgroundTerminals(null), []);
    assert.deepEqual(tr.spawnedThreads({ tool: 'spawn', receiverThreadIds: [] }), []);
    assert.deepEqual(tr.spawnedThreads({ tool: 'spawn', agentThreadId: 7 }), ['7']);
    assert.deepEqual(tr.spawnedThreads(null as any), []);
    assert.deepEqual(tr.childThreads([{ kind: 'started', agentThreadId: 'x' }]), [{ id: 'x', title: 'Agent', status: null }]);
  });

  test('commands: a Claude catalog without skills or terminal commands; Sage entries with a Why', () => {
    const p = commands.claudeCommands([{ name: 'review', description: 'r', argumentHint: '' }] as any, {});
    assert.equal(p.kind, 'claude');
    const reg = commands.composeCommands(p);
    assert.ok(reg.menu.length > 0);
  });

  test('MCP rows and the voice dialog with missing fields', () => {
    assert.deepEqual(entries.codexMcpRows(null as any), []);
    assert.deepEqual(entries.codexMcpRows([{ name: 'a' }, { name: 'b', authStatus: 'notLoggedIn' }]), [
      { name: 'a', desc: '0 tools' },
      { name: 'b', desc: 'Not signed in' },
    ]);
    assert.deepEqual(entries.claudeMcpRows(null as any), []);
    assert.deepEqual(
      entries
        .claudeMcpRows([
          { name: 'a', status: 'connected' },
          { name: 'b', status: 'needs-auth' },
          { name: 'c', status: 'failed' },
          { name: 'd' },
        ])
        .map((r) => r.desc),
      ['0 tools', 'Not signed in', 'failed', 'unknown'],
    );
  });

  test('instruction files: first tier in its config folder, basic tier only a user-level file', () => {
    const roots = { home: '/h', codexHome: '/h/.codex', claudeRoot: '/h/.claude' };
    assert.equal(instructions.instructionsPath('codex', roots), '/h/.codex/AGENTS.md');
    assert.equal(instructions.instructionsPath('codex', roots, []), '/h/.codex/AGENTS.md');
    assert.equal(instructions.instructionsPath('claude', roots, []), '/h/.claude/CLAUDE.md');
    assert.equal(instructions.instructionsPath('acp:qwen', roots), '/h/.qwen/QWEN.md');
    assert.equal(instructions.instructionsPath('acp:kimi', roots), null);
    assert.equal(instructions.instructionsPath('acp:none' as any, roots), null);
    assert.equal(instructions.instructionsPath('acp:x' as any, roots, ['/etc/agents.md']), '/etc/agents.md');
  });

  test('registry: resume commands, labels and tiers', () => {
    ownership.noteOwner('claude:abc', 'claude');
    assert.equal(registry.resumeCommandFor('codex-1'), 'codex resume codex-1');
    assert.equal(registry.resumeCommandFor('claude:abc'), 'claude --resume abc');
    // MoPilot's key for an opencode chat isn't opencode's id: no command until the agent's own session id is known
    assert.equal(registry.resumeCommandFor('acp:opencode:s1'), null);
    acpSessions.noteAcpSession('acp:opencode:s1', 'ses_abc');
    acpSessions.noteAcpSession('acp:opencode:s1', null);
    assert.equal(registry.resumeCommandFor('acp:opencode:s1'), 'opencode --session ses_abc');
    // a session id for a harness MoPilot doesn't know has no command either
    acpSessions.noteAcpSession('acp:nobody:s2', 'ses_x');
    assert.equal(registry.resumeCommandFor('acp:nobody:s2'), null);
    assert.equal(registry.resumeCommandFor('acp:kimi:s1'), null);
    assert.equal(registry.resumeCommandFor('acp:nobody:s1'), null);
    assert.equal(registry.harnessLabelOf('acp:nobody:s1'), 'nobody');
    assert.equal(registry.harnessLabelOf('acp::s1'), 'Assistant');
    assert.equal(registry.harnessLabelOf('acp:kimi:s1'), 'Kimi Code');
    assert.deepEqual(
      registry.harnessesByTier('first').map((h: any) => h.kind),
      ['codex', 'claude'],
    );
  });

  test('switch sheet: effort mapping, multiple agents, counts and missing choices', () => {
    assert.equal(plan.mapEffort(null, ['low', 'high'], 'high'), 'high');
    assert.equal(plan.mapEffort('ultra', ['low', 'high'], null), 'low');
    assert.equal(plan.mapEffort(null, ['low'], 'max'), 'low');
    assert.equal(plan.mapEffort('weird', ['low', 'high'], 'high'), 'high');
    assert.equal(plan.mapEffort('weird', ['low', 'high'], null), 'low');
    assert.equal(plan.mapEffort('weird', ['low', 'high'], 'max'), 'low');
    assert.equal(plan.mapEffort('max', ['low', 'high'], null), 'high');
    assert.equal(plan.mapEffort('low', ['ultra'], null), null);
    assert.equal(plan.multiAgentIsOn('codex', 'ultra', false), true);
    assert.equal(plan.multiAgentIsOn('codex', 'high', true), false);
    assert.equal(plan.multiAgentIsOn('claude', 'ultra', true), true);
    assert.equal(plan.canCarryMultiAgent('codex', ['ultra']), true);
    assert.equal(plan.canCarryMultiAgent('claude', ['ultra']), false);
    const base = {
      from: 'codex',
      to: 'claude',
      fromLabel: 'Codex',
      toLabel: 'Claude Code',
      vendor: 'Anthropic',
      account: 'a@x',
      goal: { objective: 'ship', status: 'active' },
      effortFrom: null,
      targetEfforts: [],
      targetDefaultEffort: null,
      permission: 'default',
      targetAutoMode: undefined,
      multiAgentOn: false,
      queued: 0,
    } as any;
    const p = plan.sheetPlan(base);
    assert.match(p.effort.text, /Default → Default/);
    assert.equal(plan.sheetPlan({ ...base, goal: { objective: 'x', status: 'complete' } }).goal, null);
  });

  test('plan labels keep a name that already starts with Claude', () => {
    assert.equal(types.claudePlanLabel('claude_claude_team'), 'claude team');
    assert.equal(types.claudePlanLabel(null, null), null);
  });

  test('ownership: a chat with no record, segments or none', () => {
    ownership.noteChat('x', null);
    ownership.noteChat('y', { kind: 'claude', segments: [{ harness: 'codex', nativeId: 'y2' } as any] });
    ownership.noteSegments(null);
    ownership.noteOwner('z', null);
    assert.deepEqual(
      [ownership.ownerOf('x'), ownership.ownerOf('y'), ownership.ownerOf('y2'), ownership.ownerOf(null)],
      ['codex', 'claude', 'codex', 'codex'],
    );
  });

  test('shell polyfill: status lines and a pty that misbehaves', async (t) => {
    assert.match(shell.shellAttachment({ cmd: 'x', cwd: '/', output: '', exitCode: null }).text, /exit unknown/);
    assert.match(shell.shellAttachment({ cmd: 'x', cwd: '/', output: '', exitCode: 1, timedOut: true }).text, /timed out/);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let sink: any;
    const pty = (spawn: (id: string) => Promise<unknown>) => ({
      spawn,
      kill: async () => {},
      onEvent: (cb: any) => ((sink = cb), () => {}),
    });
    // other runs' events are ignored; data without text adds nothing; an exit without a code is null; a second exit changes nothing
    const r1 = await shell.runShell(
      pty(async (id) => {
        sink({ id: 'other', type: 'data', data: 'x' });
        sink({ id, type: 'data' });
        sink({ id, type: 'data', data: 'ok' });
        sink({ id, type: 'exit' });
        sink({ id, type: 'exit', exitCode: 0 });
      }),
      'ls',
      '/',
    );
    assert.deepEqual([r1.output, r1.exitCode, r1.timedOut], ['ok', null, false]);
    // the timeout kills it
    const q = shell.runShell(
      pty(async () => {}),
      'ls',
      '/',
      { timeoutMs: 10 },
    );
    t.mock.timers.tick(10);
    const r = await q;
    assert.deepEqual([r.timedOut, r.exitCode], [true, null]);
    // a spawn failure after the timeout is ignored
    let late: any;
    const lateRun = shell.runShell(
      pty(() => new Promise((_res, rej) => (late = rej))),
      'ls',
      '/',
      { timeoutMs: 5 },
    );
    t.mock.timers.tick(5);
    assert.equal((await lateRun).timedOut, true);
    late(new Error('too late'));
    await new Promise((res) => setImmediate(res));
    // a spawn that fails rejects
    await assert.rejects(
      shell.runShell(
        pty(async () => {
          throw new Error('no pty');
        }),
        'ls',
        '/',
      ),
      /no pty/,
    );
    t.mock.timers.reset();
  });

  test('compat: version order', () => {
    const cmp = compat.compareVersions;
    assert.equal(cmp('1.0', '1.0.0'), 0);
    assert.equal(cmp('1.0.0-alpha', '1.0.0'), -1);
    assert.equal(cmp('1.0.0', '1.0.0-alpha'), 1);
    assert.equal(cmp('1.0.0-alpha', '1.0.0-alpha.1'), -1);
    assert.equal(cmp('1.0.0-alpha.1', '1.0.0-alpha'), 1);
    assert.equal(cmp('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
    assert.equal(cmp('1.0.0-alpha.10', '1.0.0-alpha.2'), 1);
    assert.equal(cmp('1.0.0-1', '1.0.0-alpha'), -1);
    assert.equal(cmp('1.0.0-alpha', '1.0.0-1'), 1);
    assert.equal(cmp('1.0.0-beta', '1.0.0-alpha'), 1);
    assert.equal(cmp('1.0.0-alpha', '1.0.0-beta'), -1);
    assert.equal(cmp('v2.x', '2.0'), 0);
  });
}

export function registerContractFallback() {
  test('more edges: question cards, an Error from a read, matching skills, known-bad Codex, version tails', async () => {
    const card: { params: any } = approvals.toRequest(
      'c',
      {
        id: 1,
        method: 'claude/permission',
        params: {
          toolName: 'AskUserQuestion',
          input: { questions: [{ question: 'Q', header: 'H', options: [{ label: 'a' }], multiSelect: true }] },
        },
      },
      null,
      0,
    )!;
    assert.deepEqual(card.params.questions[0], {
      id: '0',
      header: 'H',
      question: 'Q',
      options: [{ label: 'a' }],
      isOther: true,
      isSecret: false,
      multiSelect: true,
    });
    const fetches: any[] = [];
    await usage.createUsageRefresher({
      read: async () => {
        throw new Error('boom');
      },
      current: () => null,
      noteReading: () => {},
      noteFetch: (...a) => fetches.push(a),
    })('a');
    assert.deepEqual(fetches.at(-1), ['a', 'error', 'boom', undefined]);
    const res: any = {
      data: [
        { cwd: '/w', skills: [{ name: 'a', scope: 'user', path: '/u/a' }] },
        { cwd: '/o', skills: [{ name: 'b', scope: 'user', path: '/u/b' }] },
      ],
    };
    assert.deepEqual(
      catalog.composerCodexSkills(res, '/w').map((s) => s.name),
      ['a'],
    );
    assert.equal(compatCodex.codexIncompatible({ versionStatus: 'knownBad' } as any), true);
    assert.equal(compat.compareVersions('1.0', '1.0.1'), -1);
    assert.equal(compat.compareVersions('1.0.1', '1.0'), 1);
    assert.equal(tr.compactionLabel({ trigger: 'manual' }), 'Context compacted');
    assert.equal(tr.turnCard([{ type: 'agentMessage', text: 'plan', questions: [] }], true, false)!.kind, 'plan');
    assert.equal(tr.turnCard([{ type: 'agentMessage', text: 'q?', questions: [{}] }, null], true, false), null);
    assert.equal(tr.backgroundTerminals({ data: [{ processId: 2, osPid: 99, itemId: 'i', command: 'c', cwd: '/' }] })[0].osPid, 99);
    assert.deepEqual(
      tr.childThreads([{ tool: 'spawn', receiverThreadIds: ['a', 'b'], status: 'running' }]).map((c) => c.title),
      ['Agent 1', 'Agent 2'],
    );
  });
}
