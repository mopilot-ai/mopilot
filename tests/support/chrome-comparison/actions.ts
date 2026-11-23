// Per-action latency cases of the Chrome comparison: transcripts of Claude Code and Codex timed per browser call, and the summaries.
import { test, assert, fs, os, path, ARMS, electronDriver, fakePage } from './fixture.ts';
import {
  classify,
  isBrowserTool,
  claudeActions,
  codexActions,
  collectActions,
  summarizeActions,
  actionTable,
} from '../../../scripts/chrome-compare/actions.mjs';

const jl = (...xs: any[]) => xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
const T = (s: number) => new Date(Date.UTC(2026, 9, 20, 1, 0, s)).toISOString();
const W = { from: Date.UTC(2026, 9, 20, 1, 0, 0), to: Date.UTC(2026, 9, 20, 1, 5, 0) };

export function registerActions() {
  test('actions: a call is sorted by its action argument, then its tool name, then the script a Codex call runs', () => {
    assert.equal(classify('mcp__x__computer', { action: 'screenshot' }), 'screenshot');
    assert.equal(classify('mcp__x__computer', { action: 'left_click' }), 'click');
    assert.equal(classify('mcp__x__computer', { action: 'scroll' }), 'click');
    assert.equal(classify('mcp__mopilot_chrome__navigate', { url: 'http://b' }), 'navigate');
    assert.equal(classify('mcp__x__form_input', {}), 'type');
    assert.equal(classify('mcp__x__read_page', {}), 'read');
    assert.equal(classify('mcp__cua_repl__js', { code: 'await tab.goto("http://b")' }), 'navigate');
    assert.equal(classify('mcp__cua_repl__js', { code: 'await tab.snapshot()' }), 'read');
    assert.equal(classify('mcp__playwright__browser_type', {}), 'type');
    assert.equal(classify('mcp__x__computer', { action: 'key' }), 'type');
    assert.equal(classify('mcp__x__tool', { action: 7 }), 'other');
    assert.equal(classify('', undefined), 'other');
    assert.equal(isBrowserTool('mcp__claude-in-chrome__navigate'), true);
    assert.equal(isBrowserTool('Bash'), false);
    assert.equal(isBrowserTool('mcp__mopilot_chats__list'), false);
    assert.equal(isBrowserTool(undefined), false);
  });

  test('actions: Claude Code’s tool_use to tool_result time per browser call, inside the window only', () => {
    const use = (id: string, name: string, input: any, s: number) => ({
      timestamp: T(s),
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
    const res = (id: string, s: number, err = false) => ({
      timestamp: T(s),
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: err, content: id === 'a' ? 'abcd' : undefined }] },
    });
    const text = jl(
      'not json',
      use('a', 'mcp__mopilot_chrome__navigate', { url: 'u' }, 10),
      res('a', 12),
      use('b', 'Bash', {}, 13),
      res('b', 14),
      use('c', 'mcp__mopilot_chrome__click', {}, 15),
      res('c', 16, true),
      res('orphan', 17),
      { timestamp: T(18), message: { content: 'plain text' } },
      use('d', 'mcp__mopilot_chrome__navigate', {}, 600),
      res('d', 601),
    );
    assert.deepEqual(claudeActions(text, W), [
      { tool: 'mcp__mopilot_chrome__navigate', action: 'navigate', ms: 2000, error: false, chars: 6 },
      { tool: 'mcp__mopilot_chrome__click', action: 'click', ms: 1000, error: true, chars: 2 },
    ]);
  });

  test('actions: Codex’s function_call to function_call_output time per browser call, with scripts and bad arguments', () => {
    const call = (id: string, name: string, args: string, s: number, ns = 'mcp__cua_repl') => ({
      timestamp: T(s),
      payload: { type: 'function_call', call_id: id, name, namespace: ns, arguments: args },
    });
    const out = (id: string, s: number, text = 'ok') => ({
      timestamp: T(s),
      payload: { type: 'function_call_output', call_id: id, output: text },
    });
    const text = jl(
      'not json',
      call('a', 'js', JSON.stringify({ code: 'await tab.goto("u")' }), 10),
      out('a', 13),
      call('b', 'js', 'await tab.click("#x")', 14),
      out('b', 15, 'Timed out running CDP command'),
      call('c', 'shell', '{}', 16, ''),
      out('c', 17),
      call('d', 'js', '{}', 18, undefined as any),
      { timestamp: T(25), payload: { type: 'function_call', call_id: 'n', name: 'js', namespace: 'mcp__cua_repl', arguments: 'null' } },
      { timestamp: T(26), payload: { type: 'function_call_output', call_id: 'n', output: 'ok' } },
      { timestamp: T(21), payload: { type: 'function_call', call_id: 'g' } },
      { timestamp: T(22), payload: { type: 'function_call_output', call_id: 'g' } },
      { timestamp: T(23), payload: { type: 'function_call', call_id: 'h', name: 'browser_click' } },
      { timestamp: T(24), payload: { type: 'function_call_output', call_id: 'h' } },
      out('lost', 19),
      { timestamp: T(20) },
      call('e', 'js', '{}', 700),
      out('e', 701),
    );
    const got = codexActions(text, W);
    assert.deepEqual(
      got.map((g: any) => [g.action, g.ms, g.error]),
      [
        ['navigate', 3000, false],
        ['click', 1000, true],
        ['other', 1000, false],
        ['click', 1000, false],
      ],
    );
  });

  test('actions: Codex code-mode exec calls are timed by the MCP tools they run, a batch by its first', () => {
    const exec = (id: string, code: string | undefined, s: number) => ({
      timestamp: T(s),
      payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input: code },
    });
    const done = (id: string, s: number) => ({ timestamp: T(s), payload: { type: 'custom_tool_call_output', call_id: id, output: [] } });
    const text = jl(
      exec('a', 'const r = await tools.mcp__sage_1__chrome_navigate({url: "u"}); text(r)', 10),
      done('a', 12),
      exec('b', 'await Promise.all([tools.mcp__sage_1__chrome_get_page_text({}), tools.mcp__sage_1__chrome_find({})])', 13),
      done('b', 14),
      exec('c', 'text(ALL_TOOLS.length)', 15),
      exec('e', 'await tools.mcp__sage_1__chrome_computer({action: "left_click", ref: "ref_2"})', 25),
      done('e', 26),
      done('c', 16),
      exec('d', undefined, 17),
      done('d', 18),
    );
    assert.deepEqual(codexActions(text, W), [
      { tool: 'mcp__sage_1__chrome_navigate', action: 'navigate', ms: 2000, error: false, chars: 2 },
      { tool: 'mcp__sage_1__chrome_get_page_text+mcp__sage_1__chrome_find', action: 'read', ms: 1000, error: false, chars: 2 },
      { tool: 'mcp__sage_1__chrome_computer', action: 'click', ms: 1000, error: false, chars: 2 },
    ]);
  });

  test('actions: transcripts under a home folder are found by harness and time, and ACP harnesses have none', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-'));
    const claude = path.join(home, '.claude', 'projects', 'proj');
    const codex = path.join(home, '.codex', 'sessions', '2026', '10', '20');
    fs.mkdirSync(claude, { recursive: true });
    fs.mkdirSync(codex, { recursive: true });
    const line = (kind: string) =>
      kind === 'claude'
        ? jl(
            { timestamp: T(1), message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__x__browser_navigate', input: {} }] } },
            { timestamp: T(2), message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } },
          )
        : jl(
            {
              timestamp: T(1),
              payload: { type: 'function_call', call_id: 'a', name: 'js', namespace: 'mcp__cua_repl', arguments: '{"code":"goto"}' },
            },
            { timestamp: T(3), payload: { type: 'function_call_output', call_id: 'a', output: 'ok' } },
          );
    fs.writeFileSync(path.join(claude, 's.jsonl'), line('claude'));
    fs.writeFileSync(path.join(claude, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(codex, 'rollout-1.jsonl'), line('codex'));
    // a link to nothing cannot be statted: skipped
    fs.symlinkSync(path.join(home, 'nowhere'), path.join(claude, 'dangling.jsonl'));
    assert.deepEqual(
      collectActions('claude', { ...W, home }).map((a: any) => a.ms),
      [1000],
    );
    assert.deepEqual(
      collectActions('codex', { ...W, home }).map((a: any) => a.ms),
      [2000],
    );
    // a transcript that cannot be read counts nothing
    const locked = path.join(claude, 'locked.jsonl');
    fs.writeFileSync(locked, line('claude'));
    fs.chmodSync(locked, 0);
    assert.deepEqual(
      collectActions('claude', { ...W, home }).map((a: any) => a.ms),
      [1000],
    );
    // untouched since before the task started
    assert.deepEqual(collectActions('claude', { from: Date.now() + 60_000, to: Date.now() + 120_000, home }), []);
    assert.deepEqual(collectActions('opencode', { ...W, home }), []);
    assert.deepEqual(collectActions('claude', { ...W, home: path.join(home, 'none') }), []);
  });

  test('actions: the summary per arm, harness and action, and its table', () => {
    const rows = summarizeActions([
      {
        arm: 'ext',
        harness: 'claude',
        actions: [
          { action: 'click', ms: 100, error: false },
          { action: 'click', ms: 300, error: true },
        ],
      },
      {
        arm: 'ext',
        harness: 'claude',
        actions: [
          { action: 'click', ms: 200, error: false },
          { action: 'read', ms: 50, error: false },
        ],
      },
      { arm: 'native', harness: 'codex' },
    ]);
    assert.deepEqual(rows[0], { arm: 'ext', harness: 'claude', action: 'click', n: 3, medianMs: 200, maxMs: 300, errors: 1 });
    assert.equal(rows.length, 2);
    // an even count takes the middle pair's mean
    assert.equal(
      summarizeActions([
        {
          arm: 'a',
          harness: 'h',
          actions: [
            { action: 'x', ms: 10, error: false },
            { action: 'x', ms: 20, error: false },
          ],
        },
      ])[0].medianMs,
      15,
    );
    assert.match(actionTable(rows), /\| ext \| claude \| click \| 3 \| 200 \| 300 \| 1 \|/);
    assert.deepEqual(summarizeActions([]), []);
  });

  test('actions: the driver times a task’s browser calls from the home folder’s transcripts, and only when given one', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-driver-'));
    const dir = path.join(home, '.claude', 'projects', 'p');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 's.jsonl'),
      jl(
        { timestamp: T(12), message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__mopilot_chrome__click', input: {} }] } },
        { timestamp: T(13), message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } },
      ),
    );
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-work-'));
    const run = async (actionsHome: string | null) => {
      const fp = fakePage({ stopPolls: 0 });
      const electron = { launch: async () => ({ firstWindow: async () => fp.page, close: async () => undefined }) };
      let t = Date.UTC(2026, 9, 20, 1, 0, 0);
      const d = electronDriver({
        app: '/a',
        userDataDir: '/s',
        work,
        uploadFile: '/f',
        electron,
        spawn: (() => ({ unref() {} })) as any,
        pollMs: 1,
        startMs: 3,
        now: () => (t += 10_000),
        actionsHome,
      });
      return d.runTask(await d.start('native', ARMS.native), { harness: 'claude', prompt: 'p', timeoutMs: 1e9 });
    };
    assert.deepEqual((await run(home)).actions, [
      { tool: 'mcp__mopilot_chrome__click', action: 'click', ms: 1000, error: false, chars: 2 },
    ]);
    assert.equal('actions' in (await run(null)), false);
  });

  test('probe: called with the arm’s Chrome on every poll while a turn runs, and once when it has ended', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-work-'));
    const fp = fakePage({ stopPolls: 3 });
    const electron = { launch: async () => ({ firstWindow: async () => fp.page, close: async () => undefined }) };
    const phases: string[] = [];
    const d = electronDriver({
      app: '/a',
      userDataDir: '/s',
      work,
      uploadFile: '/f',
      electron,
      spawn: (() => ({ unref() {} })) as any,
      pollMs: 1,
      startMs: 3,
      probe: async (own: any, phase: string) => void phases.push(`${phase}:${own === null ? 'no-chrome' : 'chrome'}`),
    });
    await d.runTask(await d.start('native', ARMS.native), { harness: 'claude', prompt: 'p', timeoutMs: 1e9 });
    assert.deepEqual(phases, ['tick:no-chrome', 'tick:no-chrome', 'done:no-chrome']);
  });

  test('flags: --flags are added to every arm’s own switches', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flags-work-'));
    const launched: any[] = [];
    const electron = {
      launch: async (o: any) => (
        launched.push(o), { firstWindow: async () => fakePage({ stopPolls: 0 }).page, close: async () => undefined }
      ),
    };
    const mk = (extraFlags?: string) =>
      electronDriver({
        app: '/a',
        userDataDir: '/s',
        work,
        uploadFile: '/f',
        electron,
        spawn: (() => ({ unref() {} })) as any,
        env: {},
        extraFlags,
      });
    await mk('shared.browser.chromePageTree=1').start('b2', ARMS.b2);
    await mk().start('b2', ARMS.b2);
    assert.equal(launched[0].env.MOPILOT_FLAGS, 'shared.browser.chromeRelay=1,shared.browser.chromePageTree=1,native.claude.chrome=0');
    assert.equal(launched[1].env.MOPILOT_FLAGS, ARMS.b2.flags);
  });
}
