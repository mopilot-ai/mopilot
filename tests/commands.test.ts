// Command registry: the three providers, composition, aliases, native-first passthrough, basic-tier rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { codexCommands, claudeCommands, acpCommands, composeCommands, appEntries, resolveTyped, parseSlash, APP_COMMANDS, slashNames } =
  await import('../src/harness/commands.ts');
type Binding = import('../src/harness/adapter.ts').Binding;

// a few rows shaped like Claude Code's supportedCommands (made-up descriptions)
const claudeList = [
  { name: 'goal', description: 'Keep working until a condition holds', argumentHint: '<condition>', builtin: true },
  { name: 'code-review', description: 'Review changes', aliases: ['review'], builtin: true },
  { name: 'compact', description: 'Compact the conversation', builtin: true },
  { name: 'model', description: 'Set the model', builtin: true },
  { name: 'schedule', description: 'Schedule a routine', builtin: true },
  { name: 'doctor', description: 'Check the install', builtin: true },
  { name: 'clear', description: 'Clear history', aliases: ['reset', 'new'], builtin: true },
  { name: 'deploy-notes', description: 'A user command', builtin: false },
  { name: 'tidy', description: 'A skill', builtin: false },
];
const claude = () => claudeCommands(claudeList, { terminalSlash: ['doctor', 'color', 'focus', 'reload-plugins'], skills: ['tidy'] });
const names = (cs: { name: string }[]) => cs.map((c) => c.name);

test('Codex provider: a static table Sage dispatches, Init marked as a polyfill', () => {
  const p = codexCommands();
  assert.equal(p.native.length, 0);
  const init = p.sage.find((c) => c.name === 'init')!;
  assert.equal(init.dispatch, 'polyfill');
  assert.match(init.description, /by MoPilot$/);
  assert.equal(p.sage.find((c) => c.name === 'goal')!.dispatch, 'rpc');
});

test('Claude provider: passthrough commands with aliases, minus terminal-only and interactive-only ones', () => {
  const p = claude();
  assert.deepEqual(names(p.native), ['goal', 'code-review', 'compact', 'model', 'schedule', 'deploy-notes', 'tidy']);
  assert.ok(p.native.every((c) => c.dispatch === 'passthrough'));
  const review = p.native.find((c) => c.name === 'code-review')!;
  assert.deepEqual(review.aliases, ['review']);
  assert.equal(review.semantic, 'review');
  assert.equal(p.native.find((c) => c.name === 'tidy')!.source, 'skill');
  assert.equal(p.native.find((c) => c.name === 'deploy-notes')!.source, 'custom');
  assert.equal(p.native.find((c) => c.name === 'schedule')!.description, 'Cloud routine on claude.ai (not in MoPilot Scheduled)');
  assert.ok(names(p.sage).includes('status'));
});

test('ACP provider: available_commands_update, or unlisted until the first push', () => {
  const p = acpCommands('Kimi Code', [
    { name: 'goal', description: 'Set a goal', input: { hint: 'condition' } },
    { name: '/init', description: 'Write AGENTS.md' },
  ]);
  assert.equal(p.listed, true);
  assert.deepEqual(names(p.native), ['goal', 'init']);
  assert.equal(p.native[0].hint, 'condition');
  assert.equal(acpCommands('dsh', null).listed, false);
  assert.equal(acpCommands('opencode', []).listed, true);
});

test('menu: Sage UI commands plus the harness catalog; reserved names stay Sage’s', () => {
  const reg = composeCommands(claude());
  const menu = names(reg.menu);
  for (const n of ['new', 'settings', 'diff', 'fork', 'tasks', 'model', 'permissions', 'goal', 'code-review'])
    assert.ok(menu.includes(n), n);
  assert.equal(menu.filter((n) => n === 'model').length, 1);
  // /tasks is Sage's for every harness, drawn once even where Claude Code lists it as an interactive-only screen
  assert.equal(menu.filter((n) => n === 'tasks').length, 1);
  assert.equal(reg.menu.find((c) => c.name === 'tasks')!.semantic, 'tasks');
  assert.ok(!menu.includes('clear'));
  assert.equal(reg.menu.find((c) => c.name === 'model')!.source, 'app');
});

test('a chat whose capabilities have not arrived (absent, no Why) filters nothing and does not throw', () => {
  const absent = Object.fromEntries(
    ['goal', 'fork', 'review', 'compact', 'init'].map((s) => [s, { state: 'absent', via: 'none' }]),
  ) as never;
  const reg = composeCommands(claude(), absent);
  assert.deepEqual(reg.hidden, []);
  assert.deepEqual(names(reg.menu), names(composeCommands(claude()).menu));
});

test('a native command with the same name passes through ahead of Sage’s', () => {
  const app = [
    ...APP_COMMANDS,
    { name: 'init', description: 'Sage init', semantic: 'init' as const, source: 'app' as const, dispatch: 'polyfill' as const },
  ];
  const reg = composeCommands(acpCommands('Kimi Code', [{ name: 'init', description: 'Kimi init' }]), undefined, app);
  assert.equal(reg.menu.filter((c) => c.name === 'init').length, 1);
  assert.equal(reg.menu.find((c) => c.name === 'init')!.description, 'Kimi init');
  assert.deepEqual(resolveTyped('/init', reg), { kind: 'passthrough', text: '/init', command: reg.provider.native[0] });
});

test('aliases can be typed', () => {
  const reg = composeCommands(claude());
  const r = resolveTyped('/review the auth change', reg);
  assert.equal(r.kind, 'passthrough');
  assert.equal((r as { text: string }).text, '/review the auth change');
  assert.ok(resolveTyped('/reset', reg).kind === 'ui');
});

test('/model and /permissions: Sage’s picker without arguments, the harness’s command with them', () => {
  const reg = composeCommands(claude());
  assert.equal(resolveTyped('/model', reg).kind, 'ui');
  assert.deepEqual(resolveTyped('/model opus', reg), {
    kind: 'passthrough',
    text: '/model opus',
    command: reg.provider.native.find((c) => c.name === 'model'),
  });
  // Codex has no native /model, so arguments stay with Sage
  const codex = resolveTyped('/model gpt-x', composeCommands(codexCommands()));
  assert.equal(codex.kind, 'ui');
  assert.equal((codex as { args: string }).args, 'gpt-x');
});

test('/clear maps to a new chat and /exit is never sent', () => {
  const reg = composeCommands(claude());
  const r = resolveTyped('/clear', reg);
  assert.equal(r.kind, 'ui');
  assert.equal((r as { command: { name: string } }).command.name, 'new');
  assert.deepEqual(resolveTyped('/exit', reg), { kind: 'blocked', name: 'exit' });
});

test('Codex: rpc and polyfill commands dispatch with their arguments', () => {
  const reg = composeCommands(codexCommands());
  const goal = resolveTyped('/goal all tests pass', reg);
  assert.equal(goal.kind, 'rpc');
  assert.equal((goal as { args: string }).args, 'all tests pass');
  assert.equal(resolveTyped('/init', reg).kind, 'polyfill');
});

test("/plan typed is the composer's mode switch on Codex and Claude Code alike, with the text after it", () => {
  for (const provider of [codexCommands(), claude()]) {
    const r = resolveTyped('/plan fix the login bug', composeCommands(provider));
    assert.equal(r.kind, 'ui', provider.label);
    assert.deepEqual([(r as { command: { name: string } }).command.name, (r as { args: string }).args], ['plan', 'fix the login bug']);
  }
});

test('Codex: an unknown command offers plain text; a path stays a question', () => {
  const reg = composeCommands(codexCommands());
  assert.deepEqual(resolveTyped('/frobnicate', reg), {
    kind: 'unknown',
    name: 'frobnicate',
    note: "Codex doesn't have this command · Send as plain text",
  });
  assert.deepEqual(resolveTyped('/usr/local/bin has no node', reg), { kind: 'text' });
  assert.deepEqual(resolveTyped('/tmp/x.log is empty', reg), { kind: 'text' });
  assert.deepEqual(resolveTyped('/notes.txt is missing', reg), { kind: 'text' });
  assert.deepEqual(resolveTyped('plain words', reg), { kind: 'text' });
});

test('caps: a harness-layer none hides Sage’s entry; typing it explains instead of sending', () => {
  const caps: Partial<Record<string, Binding>> = {
    plan: { via: 'none', why: { layer: 'harness', code: 'harness.planTerminalOnly' } },
  };
  const reg = composeCommands(claude(), caps);
  assert.ok(!names(reg.menu).includes('plan'));
  const r = resolveTyped('/plan now', reg);
  assert.equal(r.kind, 'hidden');
  assert.equal((r as { why: { code: string } }).why.code, 'harness.planTerminalOnly');
});

test('/bug and /feedback open MoPilot’s bug report on Codex, Claude Code and a basic harness, and never pass through', () => {
  // Claude lists /feedback and /bug itself, and its caps turn Codex's feedback upload off: neither changes the app's entry
  const claudeOwn = claudeCommands([...claudeList, { name: 'feedback', description: 'x' }, { name: 'bug', description: 'y' }]);
  const off = { feedback: { via: 'none', why: { layer: 'harness', code: 'harness.feedbackTerminalOnly' } } as Binding };
  const kimi = [
    { name: 'bug', description: 'Kimi’s own' },
    { name: '/feedback', description: 'Kimi’s too' },
  ];
  const registries = [
    composeCommands(codexCommands()),
    composeCommands(claudeOwn, off),
    composeCommands(acpCommands('Kimi Code', kimi)),
    composeCommands(acpCommands('Kimi Code', null)),
  ];
  for (const reg of registries)
    for (const name of ['bug', 'feedback']) {
      const r = resolveTyped(`/${name} it crashed`, reg);
      assert.equal(r.kind, 'ui', `${reg.provider.label} /${name}`);
      assert.equal((r as { command: { source: string } }).command.source, 'app');
      assert.equal((r as { args: string }).args, 'it crashed');
      assert.equal(reg.menu.filter((c) => c.name === name).length, 1, `${reg.provider.label} lists /${name} once`);
    }
  assert.ok(APP_COMMANDS.some((c) => c.name === 'bug' && c.dispatch === 'ui' && !c.semantic));
  assert.ok(!codexCommands().sage.some((c) => c.name === 'feedback'));
});

test('caps: any other layer keeps the entry, greyed out, for Sage and native commands alike', () => {
  const why = { layer: 'session' as const, code: 'session.temporaryGoal', fix: 'newChat' as const };
  const caps = {
    goal: { via: 'none', why } as Binding,
    compact: { via: 'none', why: { layer: 'session', code: 'session.turnRunning' } } as Binding,
  };
  const cl = composeCommands(claude(), caps);
  assert.deepEqual(cl.menu.find((c) => c.name === 'goal')!.why, why);
  assert.deepEqual(resolveTyped('/goal ship it', cl), { kind: 'disabled', command: cl.menu.find((c) => c.name === 'goal'), why });
  const cx = composeCommands(codexCommands(), caps);
  assert.equal(resolveTyped('/goal ship it', cx).kind, 'disabled');
  assert.equal(resolveTyped('/compact', cx).kind, 'disabled');
});

test('caps: Codex feature gates grey out the static table entry', () => {
  const caps = { goal: { via: 'none', why: { layer: 'flag', code: 'flag.off.goal', fix: 'enableFeature' } } as Binding };
  const reg = composeCommands(codexCommands(), caps);
  assert.equal(reg.menu.find((c) => c.name === 'goal')!.why!.code, 'flag.off.goal');
});

test('caps: a command the harness lists itself is never hidden', () => {
  const caps = { goal: { via: 'none', why: { layer: 'harness', code: 'harness.undeclared' } } as Binding };
  const reg = composeCommands(acpCommands('Kimi Code', [{ name: 'goal', description: 'Set a goal' }]), caps);
  assert.ok(names(reg.menu).includes('goal'));
  assert.equal(resolveTyped('/goal x', reg).kind, 'passthrough');
});

test('Claude: unknown commands go to the CLI, which hands them to the model', () => {
  const reg = composeCommands(claude());
  assert.deepEqual(resolveTyped('/whatever now', reg), { kind: 'passthrough', text: '/whatever now' });
});

test('basic tier with a catalog: commands pass through, others get a note and Send as plain text', () => {
  const reg = composeCommands(
    acpCommands('Kimi Code', [
      { name: 'goal', description: 'Set a goal' },
      { name: 'skill:tidy', description: 'A skill' },
    ]),
  );
  assert.equal(resolveTyped('/goal tests pass', reg).kind, 'passthrough');
  assert.equal(resolveTyped('/skill:tidy', reg).kind, 'passthrough');
  assert.deepEqual(resolveTyped('/review', reg), {
    kind: 'unknown',
    name: 'review',
    note: "Kimi Code doesn't list /review · Send as plain text",
  });
});

test('basic tier without a catalog: Sage UI commands, then every /xxx verbatim', () => {
  const reg = composeCommands(acpCommands('dsh', null));
  assert.deepEqual(names(reg.menu), names(APP_COMMANDS));
  assert.deepEqual(resolveTyped('/review now', reg), { kind: 'passthrough', text: '/review now' });
  assert.equal(resolveTyped('/settings', reg).kind, 'ui');
  // even a Sage command hidden by caps goes to the harness here
  const hiddenFork = composeCommands(acpCommands('dsh', null), {
    fork: { via: 'none', why: { layer: 'harness', code: 'harness.undeclared' } },
  });
  assert.deepEqual(resolveTyped('/fork', hiddenFork), { kind: 'passthrough', text: '/fork' });
});

test('parseSlash takes the first token only', () => {
  assert.deepEqual(parseSlash('/goal  make it pass '), { name: 'goal', args: 'make it pass' });
  assert.deepEqual(parseSlash('/compact\nkeep the plan'), { name: 'compact', args: 'keep the plan' });
  assert.equal(parseSlash('see /goal'), null);
  assert.equal(parseSlash('//comment'), null);
});

test('slashNames: prefix on id, title or alias, never a substring', () => {
  const n = slashNames({ id: 'code-review', title: '/code-review (/review)', aliases: ['review'] });
  assert.ok(n.some((x) => x.startsWith('rev')));
  assert.ok(!n.some((x) => x.startsWith('view')));
  assert.ok(slashNames({ id: 'plan', title: 'Plan mode' }).some((x) => x.startsWith('plan m')));
});

test('appEntries: Sage-dispatched commands with a handler, not already drawn', () => {
  const reg = composeCommands(codexCommands());
  const runnable = new Set(['new', 'settings', 'diff', 'fork', 'permissions', 'compact', 'rename', 'logout', 'skills', 'model', 'status']);
  const got = appEntries(reg.menu, new Set(['model']), runnable, new Set(['status'])).map((c) => c.name);
  assert.deepEqual(got, ['new', 'settings', 'diff', 'fork', 'permissions', 'compact', 'rename', 'skills', 'logout']);
  // an alias resolves to the same Sage command that typing runs
  assert.equal((resolveTyped('/clear', reg) as any).command.name, 'new');
});

// Claude Code 2.1.295 lists /design and /design-consent but not /design-login, its interactive panel
const designList = [
  { name: 'design', description: 'Work with Claude Design', argumentHint: '[consent|revoke]', builtin: true },
  { name: 'design-consent', description: 'Grant Claude agent access to your Design projects', builtin: true },
];

test('Claude Design: Sage offers /design-login wherever Claude lists its Design commands, and routes /design login to it', () => {
  const p = claudeCommands(designList);
  const login = p.sage.find((c) => c.name === 'design-login')!;
  assert.deepEqual([login.dispatch, login.source], ['ui', 'app']);
  assert.match(login.description, /by MoPilot$/);
  const reg = composeCommands(p);
  assert.ok(names(reg.menu).includes('design-login'));
  for (const typed of ['/design-login', '/design login', '/design LOGIN'])
    assert.deepEqual(resolveTyped(typed, reg), { kind: 'ui', command: login, args: '' });
  // the rest of /design stays Claude's
  assert.deepEqual(resolveTyped('/design consent', reg), { kind: 'passthrough', text: '/design consent', command: p.native[0] });
  assert.equal(resolveTyped('/design could you redesign this page?', reg).kind, 'passthrough');
  // listed by the CLI alone (/design-consent) is enough
  assert.ok(names(claudeCommands([designList[1]]).sage).includes('design-login'));
});

test('Claude Design: no /design-login without the Design commands, or when Claude lists its own', () => {
  const none = claudeCommands(claudeList);
  assert.ok(!names(none.sage).includes('design-login'));
  assert.equal(none.routes, undefined);
  // /design login then goes to Claude as typed
  assert.equal(resolveTyped('/design login', composeCommands(none)).kind, 'passthrough');
  const own = claudeCommands([...designList, { name: 'design-login', description: 'Authorize design-system access', builtin: true }]);
  assert.ok(!names(own.sage).includes('design-login'));
  assert.equal(resolveTyped('/design-login', composeCommands(own)).kind, 'passthrough');
});

test('a route to an entry the menu does not hold leaves the command as typed', () => {
  const p = { ...claudeCommands(designList), routes: { 'design login': 'missing' } };
  assert.equal(resolveTyped('/design login', composeCommands(p)).kind, 'passthrough');
});
