// bench/lib: the benchmark harness's pure logic (run arguments, task tiers and catalogs, prompts, grading, transcript
// reading, the summary and before/after report, MacArena and WebGames helpers, and the VM-only guard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { ARMS, BENCH_DIR, parseRunArgs } = await import('../bench/lib/config.mjs');
const { PINS, externalPaths, setupCommands } = await import('../bench/lib/external.mjs');
const { SMOKE, loadCatalog, macKey, parseRealTask, parseWebGames, selectTasks } = await import('../bench/lib/tasks.mjs');
const { finalPrompt, macPrompt, realConfigUrl, realPrompt, runTag, webGamesPrompt } = await import('../bench/lib/prompts.mjs');
const { gradeWebGames, macScore, parseJsonl, pickSiteTarget, realVerdict, resultRecord, ruleBreaks, timedOut } = await import(
  '../bench/lib/grading.mjs'
);
const { findTranscript, reachedOutsideBrowser, readActivity, readTranscript, recent, transcriptRoot } = await import(
  '../bench/lib/transcript.mjs'
);
const { benchOf, compareRuns, loadRun, median, outcome, stats, summaryTable } = await import('../bench/lib/report.mjs');
const { EXTRA_PRE, SOLUTIONS, resetScripts, uploads } = await import('../bench/lib/macarena.mjs');
const { completionEntry, contentType, staticFile } = await import('../bench/lib/webgames.mjs');
const { requireVm } = await import('../bench/lib/guard.mjs');
const { insideVirtualMachine } = createRequire(import.meta.url)('../scripts/release-suites.cjs');

const tmp = () => mkdtempSync(path.join(tmpdir(), 'bench-test-'));
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

test('run arguments: defaults, per-arm overrides, and every refusal names the usage', () => {
  const cfg = parseRunArgs(['--bench', 'wg', '--arm', 'mp-claude', '--base', 'http://127.0.0.1:8800/', '--tasks', ' a, ,b ']);
  assert.equal(cfg.bench, 'wg');
  assert.equal(cfg.armName, 'mp-claude');
  assert.deepEqual(cfg.arm, ARMS['mp-claude']);
  assert.equal(cfg.tier, 'smoke');
  assert.deepEqual(cfg.tasks, ['a', 'b']);
  assert.equal(cfg.run, 'local');
  assert.equal(cfg.timeoutS, 300);
  assert.equal(cfg.base, 'http://127.0.0.1:8800');
  assert.equal(cfg.resultsDir, path.join(BENCH_DIR, 'results', 'local', 'mp-claude'));
  assert.equal(cfg.completions, path.join(BENCH_DIR, 'results', 'webgames-completions.jsonl'));
  assert.equal(cfg.external, path.join(BENCH_DIR, 'external'));

  const o = parseRunArgs([
    '--bench',
    'real',
    '--arm',
    'mp-codex',
    '--tier',
    'full',
    '--run',
    'pr-1.a',
    '--port',
    '9400',
    '--harness',
    'X',
    '--model',
    '',
  ]);
  assert.deepEqual([o.arm.port, o.arm.harness, o.arm.model, o.tier, o.tasks], ['9400', 'X', '', 'full', []]);
  assert.equal(parseRunArgs(['--bench', 'mac', '--arm', 'desk-claude', '--model', 'M']).arm.model, 'M');

  for (const [argv, why] of [
    [['--nope'], /Unknown option/],
    [['--arm', 'mp-claude'], /--bench must be one of/],
    [['--bench', 'wg', '--arm', 'x'], /unknown --arm x/],
    [['--bench', 'wg', '--arm', 'mp-claude', '--tier', 'big'], /--tier must be/],
    [['--bench', 'wg', '--arm', 'mp-claude', '--run', '../x'], /--run must be a plain name/],
    [['--bench', 'wg', '--arm', 'mp-claude', '--run', '..'], /not \. or \.\./],
    [['--bench', 'wg'], /unknown --arm undefined/],
    [['--bench', 'wg', '--arm', 'constructor'], /unknown --arm constructor/],
    [['--bench', 'wg', '--arm', '__proto__'], /unknown --arm __proto__/],
    [['--bench', 'wg', '--arm', 'mp-claude', '--timeout', '1.5'], /--timeout must be/],
    [['--bench', 'wg', '--arm', 'mp-claude', '--timeout', '0'], /--timeout must be/],
  ] as const) {
    assert.throws(
      () => parseRunArgs([...argv]),
      (e: Error) => why.test(e.message) && /usage: node bench\/run\.mjs/.test(e.message),
    );
  }
});

test('external checkouts: pinned commits, the paths the runner reads, and clone-or-fetch setup', () => {
  for (const pin of Object.values(PINS) as { repo: string; commit: string }[]) {
    assert.match(pin.commit, /^[0-9a-f]{40}$/);
    assert.match(pin.repo, /^https:\/\/github\.com\//);
  }
  const p = externalPaths('/x');
  assert.equal(p.webgamesCatalog, '/x/webgames/analysis/webgames_tasks.jsonl');
  assert.equal(p.realGraders, '/x/agisdk/src/agisdk/REAL/browsergym/webclones/v2/eval_scripts');
  assert.equal(p.macarenaTasks, '/x/MacArena/evaluation_examples/macarena');

  const fresh = setupCommands('/x', () => false);
  assert.deepEqual(fresh[0], ['git', ['clone', '--filter=blob:none', PINS.webgames.repo, '/x/webgames'], '/x']);
  assert.deepEqual(fresh[1], ['git', ['checkout', '--detach', PINS.webgames.commit], '/x/webgames']);
  assert.equal(fresh.length, 8);
  assert.deepEqual(fresh.at(-1), ['npx', ['--yes', 'pnpm@9', 'run', 'build'], '/x/webgames/webgames']);
  const again = setupCommands('/x', () => true);
  assert.deepEqual(again[0], ['git', ['fetch', 'origin'], '/x/webgames']);
});

test('task catalogs load from the checkouts, and tiers select SMOKE, FULL or the named tasks', () => {
  const ext = tmp();
  assert.throws(() => loadCatalog('wg', ext), /missing .*setup-external/);
  const p = externalPaths(ext);
  write(
    p.webgamesCatalog,
    `${JSON.stringify({ id: 'key-combo', path: 'key-combo', description: 'Press keys', password: 'PW', tags: [] })}\n\n${JSON.stringify({ id: 'b', path: 'bp', description: 'd', password: 'q' })}\n`,
  );
  assert.deepEqual(loadCatalog('wg', ext)[0], { id: 'key-combo', path: 'key-combo', description: 'Press keys', password: 'PW' });
  write(
    path.join(p.realTasks, 'gomail-16.json'),
    JSON.stringify({
      id: 'gomail-16',
      goal: 'Make a label',
      website: { url: 'https://gomail.example/' },
      evals: [{ script: 'eval_gomail_16.py' }],
    }),
  );
  write(path.join(p.realTasks, 'README.txt'), 'not a task');
  assert.deepEqual(loadCatalog('real', ext), [
    { id: 'gomail-16', goal: 'Make a label', url: 'https://gomail.example', grader: 'eval_gomail_16.py' },
  ]);
  write(path.join(p.macarenaTasks, 'productivity', 'a13331ed-680f.json'), JSON.stringify({ id: 'a13331ed-680f', instruction: 'Copy it' }));
  const mac = loadCatalog('mac', ext);
  assert.deepEqual(mac[0], { id: 'a13331ed', fullId: 'a13331ed-680f', instruction: 'Copy it', category: 'productivity' });
  assert.equal(macKey({ id: '4f0d1950-473a' }), '4f0d1950');
  assert.deepEqual(parseWebGames(''), []);
  assert.equal(
    parseRealTask({ id: 'x-1', goal: 'g', website: { url: 'https://s.example//' }, evals: [{ script: 'e.py' }] }).url,
    'https://s.example',
  );

  const catalog = [...SMOKE.wg, 'extra'].map((id) => ({ id }));
  assert.deepEqual(
    selectTasks({ bench: 'wg', tier: 'smoke', tasks: [] }, catalog).map((t) => t.id),
    SMOKE.wg,
  );
  assert.equal(selectTasks({ bench: 'wg', tier: 'full', tasks: [] }, catalog).length, 13);
  assert.deepEqual(selectTasks({ bench: 'wg', tier: 'full', tasks: ['extra'] }, catalog), [{ id: 'extra' }]);
  assert.throws(() => selectTasks({ bench: 'mac', tier: 'smoke', tasks: [] }, catalog), /not in the mac catalog: a13331ed/);
  assert.deepEqual([SMOKE.wg.length, SMOKE.real.length, SMOKE.mac.length], [12, 10, 5]);
});

test('prompts: the same words for every arm, the GUI-only rules, and the run tag', () => {
  const wg = webGamesPrompt({ description: 'Hold the button', path: 'button-hold' }, 'http://h:1', 'the in-app browser');
  assert.match(wg, /^Use the in-app browser\. Your task is: Hold the button\. You must go to http:\/\/h:1\/button-hold /);
  assert.match(wg, /do not run shell commands or scripts, and do not read the page source\.$/);
  const t = { id: 'gomail-16', url: 'https://g.example', goal: 'Make a label' };
  assert.equal(realConfigUrl(t), 'https://g.example/config?run_id=0&task_id=v2.gomail-16&latency=0&removePopup=true');
  const pre = realPrompt(t, 'the in-app browser', true);
  assert.match(pre, /is already open in the in-app browser\. Task: Make a label\n/);
  assert.doesNotMatch(pre, /config\?/);
  const self = realPrompt(t, "the app's built-in browser", false);
  assert.match(self, /First open these two setup pages .*config\?run_id=0.* and then https:\/\/g\.example\/finish /);
  assert.match(self, /Leave the site's tab open when you finish\. Reply DONE when finished\.$/);
  assert.match(macPrompt({ instruction: 'Copy the file.' }), /Task: Copy the file\.\nUse the GUI only: .*AppleScript\/osascript/);
  assert.equal(runTag('mp-claude', 'x', 36), 'bench-mp-claude-x-10');
  assert.match(runTag('a', 'b'), /^bench-a-b-[0-9a-z]+$/);
  assert.equal(finalPrompt('P', '', 'T'), 'P (run tag: T)');
  assert.equal(finalPrompt('P', 'Only the built-in browser.', 'T'), 'P Only the built-in browser. (run tag: T)');
});

test('grading: WebGames needs the password and the page completion, MacArena weighs graders, REAL needs /finish', () => {
  assert.deepEqual(parseJsonl('{"a":1}\n\n{broken\n{"b":2}'), [{ a: 1 }, { b: 2 }]);
  const task = { id: 'button-hold', path: 'button-hold', password: 'PW' };
  const pass = gradeWebGames({ task, answer: 'it is PW', completions: [{ at: 10, taskId: 'button-hold' }], since: 5 });
  assert.deepEqual(pass, {
    success: true,
    passwordInAnswer: true,
    pageCompleted: true,
    notes: 'password in answer; page completion logged',
  });
  assert.equal(gradeWebGames({ task, answer: 'PW', completions: [{ at: 10, url: 'http://h/button-hold' }], since: 5 }).success, true);
  const stale = gradeWebGames({ task, answer: 'PW', completions: [{ at: 1, taskId: 'button-hold' }, { at: 9 }], since: 5 });
  assert.deepEqual([stale.success, stale.notes], [false, 'password in answer; page completion not logged']);
  assert.equal(
    gradeWebGames({ task, answer: 'no', completions: [{ at: 9, taskId: 'button-hold' }], since: 5 }).notes,
    'password not in answer; page completion logged',
  );

  assert.equal(
    macScore(
      [
        ['a', 60],
        ['b', 40],
        ['c', 10],
      ],
      ['x\nTrue', 'False'],
    ),
    60,
  );
  assert.deepEqual(realVerdict('{"x":1}', 'grader: SUCCESS'), { gradable: true, success: true });
  assert.deepEqual(realVerdict('{"x":1}', 'FAILURE'), { gradable: true, success: false });
  assert.deepEqual(realVerdict('', 'SUCCESS'), { gradable: false, success: false });

  assert.deepEqual(ruleBreaks(['Bash', 'mcp__mopilot_browser__browser_click']), { shellUsed: true, scriptUsed: false });
  assert.deepEqual(ruleBreaks(['exec_command', 'mcp__mopilot_browser__browser_script']), { shellUsed: true, scriptUsed: true });
  assert.deepEqual(ruleBreaks(['Ran 2 commands']), { shellUsed: false, scriptUsed: false }, 'summaries are read by readActivity');

  assert.equal(timedOut({ ok: false }), true);
  assert.equal(timedOut({ ok: true }), false);
  assert.equal(timedOut({ ok: false, error: 'no home view' }), false, 'a driver or app failure is not a slow agent');
  assert.equal(timedOut({ ok: false, outsideBrowser: true }), false);

  const tabs = [{ id: 'old' }, { id: 'setup' }, { id: 'new' }];
  assert.deepEqual(pickSiteTarget(tabs, new Set(['old', 'setup']), 'setup'), {
    target: { id: 'new' },
    note: 'finish read from the tab the agent opened',
  });
  assert.deepEqual(pickSiteTarget(tabs.slice(0, 2), new Set(['old', 'setup']), 'setup'), {
    target: { id: 'setup' },
    note: 'finish read from the setup tab (the agent used it)',
  });
  assert.deepEqual(pickSiteTarget(tabs.slice(0, 2), new Set(['old', 'setup']), null), {
    target: { id: 'old' },
    note: 'finish read from a tab open before the turn (2 on the site)',
  });
  assert.deepEqual(pickSiteTarget([], new Set(), 'setup'), { target: null, note: 'no site tab after the run' });
  assert.deepEqual(ruleBreaks(['js', 'Used 3 steps']), { shellUsed: false, scriptUsed: false });

  const empty = resultRecord({ task: 't' });
  assert.deepEqual(
    [empty.success, empty.gradable, empty.unsupported, empty.score, empty.wallMs, empty.approvals, empty.notes, empty.answerTail],
    [false, true, false, null, null, 0, '', ''],
  );
  const full = resultRecord({
    task: 't',
    arm: 'a',
    bench: 'wg',
    run: 'r',
    success: 1,
    gradable: false,
    unsupported: 1,
    score: 100,
    wallMs: 5,
    timeout: 1,
    steps: 3,
    shellUsed: false,
    scriptUsed: true,
    approvals: 2,
    model: 'M',
    error: 'E',
    notes: 'N',
    tag: 'T',
    answer: 'x'.repeat(2000),
  });
  assert.deepEqual([full.success, full.gradable, full.unsupported, full.timeout, full.answerTail.length], [true, false, true, true, 1500]);
});

const claudeLines = [
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Bash' },
        { type: 'text', text: 'working' },
      ],
    },
  },
  { type: 'user', message: { content: [{ type: 'tool_result' }] } },
  { type: 'user', message: { content: 'typed text' } },
  { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'DONE PW' }] } },
];

test('transcripts: a Claude Code or Codex turn is read for done, answer, tools and rule breaks', () => {
  const claude = readTranscript('claude', claudeLines.map((l) => JSON.stringify(l)).join('\n'));
  assert.deepEqual(claude, {
    done: true,
    question: null,
    pending: null,
    denials: [],
    prompts: 1,
    answer: 'DONE PW',
    steps: 1,
    tools: { Bash: 1 },
    shellUsed: true,
    scriptUsed: false,
  });
  const running = readTranscript(
    'claude',
    claudeLines
      .slice(0, 2)
      .map((l) => JSON.stringify(l))
      .join('\n'),
  );
  assert.equal(running.done, false);
  assert.equal(readTranscript('claude', '{"type":"assistant"}').done, false);
  // a task's next message, typed after the first turn ended: running until the agent answers it, done once it has
  const ended = claudeLines.map((l) => JSON.stringify(l));
  const next = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'now open the issues' }] } });
  assert.equal(readTranscript('claude', [...ended, next].join('\n')).done, false);
  const reply = JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'opened' }] } });
  assert.deepEqual(
    [
      readTranscript('claude', [...ended, next, reply].join('\n')).done,
      readTranscript('claude', [...ended, next, reply].join('\n')).answer,
    ],
    [true, 'opened'],
  );
  // a meta record the app adds after a turn ended does not reopen it
  const meta = JSON.stringify({ type: 'user', isMeta: true, message: { content: 'caveat' } });
  assert.equal(readTranscript('claude', [...ended, meta].join('\n')).done, true);

  const codex = [
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'js' } },
    { type: 'response_item', payload: { type: 'custom_tool_call' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'a' }, {}] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'u' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'final' } },
    { type: 'session_meta' },
  ];
  const c = readTranscript('codex', codex.map((l) => JSON.stringify(l)).join('\n'));
  assert.deepEqual(c, {
    done: true,
    question: null,
    pending: null,
    denials: [],
    prompts: 1,
    answer: 'final',
    steps: 2,
    tools: { js: 1, custom_tool_call: 1 },
    shellUsed: false,
    scriptUsed: false,
  });
  const noLast = readTranscript(
    'codex',
    [
      { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
      { type: 'event_msg', payload: { type: 'turn_complete' } },
      { type: 'event_msg', payload: { type: 'turn_started' } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  );
  assert.deepEqual([noLast.done, noLast.answer], [false, '']);

  assert.equal(reachedOutsideBrowser({ 'mcp__claude-in-chrome__tabs_context_mcp': 1 }), true);
  assert.equal(reachedOutsideBrowser({ Bash: 1 }), false);

  const own = readActivity(`Ran out of moves, retrying\nRead ${'the page '.repeat(10)}\nUsed browser_script`);
  assert.deepEqual(own, { summaries: ['Ran out of moves, retrying', 'Used browser_script'], steps: 2, shellUsed: false, scriptUsed: true });
  const act = readActivity('Hello\n  Used 4 steps\nRan a command\nExplored 2 files\nsomething else');
  assert.deepEqual(act, { summaries: ['Used 4 steps', 'Ran a command', 'Explored 2 files'], steps: 6, shellUsed: true, scriptUsed: false });
});

test('transcripts are found by run tag among recent files only', () => {
  const home = tmp();
  assert.deepEqual(transcriptRoot('claude', home), { dir: path.join(home, '.claude/projects'), depth: 1 });
  assert.deepEqual(transcriptRoot('codex', home), { dir: path.join(home, '.codex/sessions'), depth: 3 });
  assert.equal(findTranscript('claude', home, 'tag-1'), null);
  const hit = path.join(home, '.claude/projects/p/s.jsonl');
  write(hit, '{"x":"tag-1"}');
  write(path.join(home, '.claude/projects/p/notes.txt'), 'tag-1');
  write(path.join(home, '.claude/projects/p/deeper/s.jsonl'), 'tag-2');
  const old = path.join(home, '.claude/projects/old.jsonl');
  write(old, 'tag-3');
  utimesSync(old, new Date(0), new Date(0));
  assert.equal(findTranscript('claude', home, 'tag-1'), hit);
  assert.equal(findTranscript('claude', home, 'tag-2'), null, 'deeper than Claude Code keeps transcripts');
  assert.equal(findTranscript('claude', home, 'tag-3'), null, 'older than an hour');
  const rollout = path.join(home, '.codex/sessions/2026/10/13/rollout-1.jsonl');
  write(rollout, 'tag-4');
  assert.equal(findTranscript('codex', home, 'tag-4', Date.now()), rollout);
  assert.equal(recent(path.join(home, 'gone.jsonl'), Date.now()), false, 'a file removed since it was listed');
});

const rec = (task: string, o: Record<string, unknown> = {}) => ({ task, success: true, wallMs: 10000, ...o });

test('report: the arm x benchmark table, legacy records, and the before/after comparison', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.deepEqual(
    [benchOf({ task: 'x', bench: 'mac' }), benchOf({ task: 'a13331ed' }), benchOf({ task: 'gomail-16' }), benchOf({ task: 'key-combo' })],
    ['mac', 'mac', 'real', 'wg'],
  );
  assert.deepEqual(
    [outcome({ unsupported: true }), outcome({ gradable: false }), outcome({ success: true }), outcome({})],
    ['unsupported', 'ungradable', 'PASS', 'fail'],
  );
  const s = stats([
    rec('a', { shellUsed: true, scriptUsed: true }),
    rec('b', { success: false, wallMs: 30000, timeout: true }),
    rec('c', { gradable: false }),
    rec('d', { unsupported: true }),
    rec('e', { wallMs: null }),
  ]);
  assert.deepEqual(s, {
    total: 5,
    graded: 3,
    passes: 2,
    rate: 2 / 3,
    medianWall: 20000,
    medianWallPasses: 10000,
    unsupported: 1,
    ungradable: 1,
    timeouts: 1,
    shell: 1,
    script: 1,
  });
  assert.equal(stats([]).rate, null);

  const table = summaryTable({
    'mp-claude': [rec('key-combo'), rec('gomail-16', { success: false }), rec('a13331ed', { bench: 'mac' })],
    'desk-claude': [rec('gomail-16', { unsupported: true })],
  });
  assert.match(table, /\| mp-claude \| WebGames \(1\) \| 1\/1 \| 100% \| 10 \| 10 \| 0 \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(table, /\| mp-claude \| REAL \(1\) \| 0\/1 \| 0% \| 10 \| - \|/);
  assert.match(table, /\| desk-claude \| REAL \(1\) \| 0\/0 \| - \| - \| - \| 1 \|/);
  assert.doesNotMatch(table, /desk-claude \| WebGames/);

  const before = { 'mp-claude': [rec('key-combo', { success: false, wallMs: 20000 }), rec('datehard')], gone: [rec('a13331ed')] };
  const after = {
    'mp-claude': [rec('key-combo', { notes: 'held the key' }), rec('datehard'), rec('new-task')],
    added: [rec('gomail-16', { gradable: false })],
  };
  const cmp = compareRuns(before, after);
  assert.match(cmp, /\| mp-claude \| WebGames \| 1\/2 \| 3\/3 \| \+50 pts \| -5 \|/);
  assert.match(cmp, /\| gone \| MacArena \| 1\/1 \| not run \| - \| - \|/);
  assert.match(cmp, /\| added \| REAL \| not run \| 0\/0 \| - \| - \|/);
  assert.match(cmp, /Changed tasks:\n- mp-claude key-combo: fail -> PASS \(held the key\)/);
  assert.match(compareRuns({ a: [rec('x', { success: false })] }, { a: [rec('x')] }), /- a x: fail -> PASS\n$/);
  assert.match(
    compareRuns({ a: [rec('x')] }, { a: [rec('x', { wallMs: 9000 })] }),
    /\| a \| WebGames \| 1\/1 \| 1\/1 \| 0 pts \| -1 \|\n\nNo task changed outcome\.\n$/,
  );
});

test('report: a run folder is read per arm, task records only', () => {
  const run = tmp();
  assert.throws(() => loadRun(path.join(run, 'missing')), /no results at/);
  write(path.join(run, 'mp-claude', 'gomail-16.json'), JSON.stringify(rec('gomail-16')));
  write(path.join(run, 'mp-claude', 'gomail-16.finish.json'), '{"state":1}');
  write(path.join(run, 'mp-claude', 'a.attempt1.json.bak'), '{}');
  write(path.join(run, 'mp-claude', 'shot.png'), '');
  write(path.join(run, 'summary.md'), '# notes');
  assert.deepEqual(loadRun(run), { 'mp-claude': [rec('gomail-16')] });
});

test('MacArena: extra resets run before the task own reset, and task files are copied into the home folder', () => {
  assert.deepEqual(resetScripts({ id: '4f0d1950', pre_command: 'reset' }), [EXTRA_PRE['4f0d1950'], 'reset']);
  assert.deepEqual(resetScripts({ id: 'a13331ed' }), []);
  assert.deepEqual(
    uploads(
      {
        pre_upload_files: [
          { local_path: 'vm_files/a.pdf', path: '~/Documents/b.pdf' },
          { local_path: 'c', path: '/tmp/c' },
        ],
      },
      '/m',
      '/home/u',
    ),
    [
      { from: '/m/vm_files/a.pdf', to: '/home/u/Documents/b.pdf' },
      { from: '/m/c', to: '/tmp/c' },
    ],
  );
  assert.deepEqual(uploads({}, '/m', '/h'), []);
  for (const id of SMOKE.mac) assert.equal(typeof SOLUTIONS[id], 'string', id);
});

test('WebGames server: files inside dist only, the app shell otherwise, and completions logged as sent', () => {
  const dist = '/srv/dist';
  const files = new Set(['/srv/dist/assets/app.js']);
  const isFile = (f: string) => files.has(f);
  assert.equal(staticFile(dist, '/assets/app.js', isFile), '/srv/dist/assets/app.js');
  assert.equal(staticFile(dist, '/button-hold', isFile), '/srv/dist/index.html');
  assert.equal(staticFile(dist, '/', isFile), '/srv/dist/index.html');
  assert.equal(
    staticFile(dist, '/../../etc/passwd', () => true),
    '/srv/dist/index.html',
  );
  assert.equal(
    staticFile(dist, '/%E0%A4%A', () => true),
    '/srv/dist/index.html',
  );
  assert.deepEqual(
    [contentType('a.js'), contentType('a.wasm'), contentType('a.bin')],
    ['text/javascript', 'application/wasm', 'application/octet-stream'],
  );
  assert.equal(completionEntry('{"taskId":"t"}', 'UA', 7), '{"at":7,"ua":"UA","taskId":"t"}\n');
  assert.equal(completionEntry('oops', undefined, 7), '{"at":7,"raw":"oops"}\n');
  assert.match(completionEntry('{}', 'UA'), /^\{"at":\d+,"ua":"UA"\}\n$/);
});

test('benchmark runs refuse to start outside a virtual machine', () => {
  assert.doesNotThrow(() => requireVm('bench/run.mjs', () => true));
  assert.throws(
    () => requireVm('bench/run.mjs', () => false),
    /bench\/run\.mjs runs only inside the benchmark virtual machine.*scripts\/vm-exec\.sh/,
  );
  // the machine running these tests may itself be a virtual machine (GitHub's macOS runners are)
  if (insideVirtualMachine()) assert.doesNotThrow(() => requireVm('x'));
  else assert.throws(() => requireVm('x'), /runs only inside/);
});
