// src/components/harness/InstallLines.tsx: a missing harness's install lines (the recommended one with Install, the
// others folded; Copy, Run, why a line can't run), the terminal of the run main owns, its time, Stop and a way out of a
// slow one, what came of a run once the harness was looked for again, and the harness looked for in the background.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, click, byText, maybeText } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
let startResult: any = { ok: true };
let startThrows: unknown = null;
let copyFails = false;
let findResult: string | null = null;
installNativeStub({
  codex: { restart: async () => calls.push(['restart']) },
  harnessRuns: {
    start: async (kind: string, index: number) => {
      calls.push(['start', kind, index]);
      if (startThrows) throw startThrows;
      return startResult;
    },
    stop: async (id: string) => calls.push(['stop', id]),
    dismiss: async (id: string) => calls.push(['dismiss', id]),
    find: async (kind: string) => (calls.push(['find', kind]), findResult),
    onData: () => () => undefined,
    attach: async () => null,
    write: () => undefined,
    resize: () => undefined,
  },
});
stubStore({
  connect: async () => calls.push(['connect']),
  toast: (...a: any[]) => calls.push(['toast', ...a]),
});
let recheckFails: unknown = null;
mock.module('../src/session/harness/claude.ts', {
  namedExports: {
    detectClaude: async () => calls.push(['detectClaude']),
    recheckClaude: async () => calls.push(['recheckClaude']),
  },
});
mock.module('../src/session/harness/acp.ts', {
  namedExports: {
    recheckBasic: async (id: string) => {
      calls.push(['recheckBasic', id]);
      if (recheckFails) throw recheckFails;
    },
  },
});
mock.module('../src/lib/platform.ts', { namedExports: { platform: 'darwin' } });
mock.module('../src/session/clipboard.ts', {
  namedExports: {
    copyText: (text: string, done: any) => {
      calls.push(['copy', text]);
      if (!copyFails) typeof done === 'function' ? done() : calls.push(['toast', done]);
    },
  },
});
mock.module('../src/session/open.ts', { namedExports: { openLink: (u: string) => calls.push(['open', u]) } });
mock.module('../src/components/panels/TerminalPanel.tsx', {
  namedExports: {
    TermView: ({ tab, transport, onExit }: any) =>
      h('div', { 'data-term': tab.id, 'data-attached': String(typeof transport === 'function'), 'data-title': tab.title, onClick: onExit }),
  },
});
const { InstallLines } = await import('../src/components/harness/InstallLines.tsx');
const { useHarnessRuns } = await import('../src/session/harness/harnessRuns.ts');
const { installLines: tableLines } = await import('../shared/harnessInstall.mjs');
const installLinesOf = (kind: string) => tableLines(kind, 'darwin', { npm: false, brew: false, npmWritable: null });

const item = (over: any = {}) => ({
  kind: 'acp:qwen',
  label: 'Qwen Code',
  vendor: 'Alibaba',
  tier: 'basic',
  state: 'missing',
  version: null,
  ...over,
});
const run = (over: any = {}) => ({
  id: 'r1',
  kind: 'acp:qwen',
  purpose: 'install',
  via: 'brew',
  command: 'brew install qwen-code',
  group: 'brew',
  state: 'running',
  code: null,
  stopped: false,
  checked: false,
  startedAt: Date.now(),
  endedAt: null,
  ...over,
});
const set = (patch: any) => act(async () => useHarnessRuns.setState(patch));
const lines = (host: HTMLElement) => [...host.querySelectorAll('.install-line')] as HTMLElement[];
const lineOf = (host: HTMLElement, via: string) => host.querySelector(`[data-install-line=${via}]`) as HTMLElement;
const reset = async () => {
  calls.length = 0;
  startResult = { ok: true };
  startThrows = null;
  copyFails = false;
  recheckFails = null;
  findResult = null;
  await set({ runs: [], tools: { npm: true, brew: true, npmWritable: true }, settled: {} });
};
const located: string[] = [];
const view = (over: any = {}) => render(h(InstallLines, { item: item(over), onSetLocation: () => located.push('locate') }));
/** What the view did, without its background asks whether the harness is there yet. */
const did = () => calls.filter((c) => c[0] !== 'find');
const others = (host: HTMLElement) => click(byText(host, 'Other ways to install'));

test("the recommended line with Install, the others folded in the vendor's order, each with its command, Run and Copy", async () => {
  await reset();
  const v = await view();
  // the vendor's own script first, alone, with the primary action
  assert.deepEqual(
    lines(v.host).map((l) => l.querySelector('.install-via')!.textContent),
    ['Script'],
  );
  const pick = byText(lineOf(v.host, 'script'), 'Install') as HTMLButtonElement;
  assert.ok(pick.classList.contains('primary'));
  assert.equal(byText(v.host, 'Other ways to install').getAttribute('aria-expanded'), 'false');
  await others(v.host);
  assert.equal(byText(v.host, 'Other ways to install').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(
    lines(v.host).map((l) => l.querySelector('.install-via')!.textContent),
    ['Script', 'Homebrew', 'npm'],
  );
  const npm = lineOf(v.host, 'npm');
  const code = npm.querySelector('code')!;
  assert.equal(code.textContent, 'npm install -g @qwen-code/qwen-code@latest');
  assert.equal(code.getAttribute('title'), code.textContent, 'the full command on hover');
  assert.equal(code.getAttribute('aria-label'), 'Install command for Qwen Code with npm');
  const runBtn = byText(npm, 'Run') as HTMLButtonElement;
  assert.equal(runBtn.getAttribute('aria-label'), 'Run npm install -g @qwen-code/qwen-code@latest');
  assert.equal(runBtn.title, 'Runs automatically; output appears below');
  assert.equal(v.host.querySelector('[data-term]'), null, 'no terminal before a run');
  await others(v.host);
  assert.deepEqual(lines(v.host).length, 1, 'folded again');
  await v.unmount();
});

test('with no line this machine can run, every line shows with why, and nothing is folded', async () => {
  await reset();
  await set({ tools: { npm: false, brew: false, npmWritable: null } });
  const v = await view({ kind: 'acp:gemini', label: 'Gemini CLI', vendor: 'Google' });
  assert.deepEqual(
    lines(v.host).map((l) => l.querySelector('.install-via')!.textContent),
    installLinesOf('acp:gemini').map((l: any) => l.label),
  );
  assert.equal(maybeText(v.host, 'Other ways to install'), null);
  assert.equal(maybeText(v.host, 'Install'), null);
  await v.unmount();
});

test('Copy copies the exact command and says so for a moment; a failed copy changes nothing', async () => {
  await reset();
  const v = await view();
  await others(v.host);
  const copy = lineOf(v.host, 'brew').querySelector('.install-copy') as HTMLButtonElement;
  assert.equal(copy.getAttribute('aria-label'), 'Copy the Homebrew command');
  await click(copy);
  assert.deepEqual(did(), [['copy', 'brew install qwen-code']]);
  assert.equal(copy.getAttribute('aria-label'), 'Copied');
  await act(() => new Promise((r) => setTimeout(r, 1600)));
  assert.equal(copy.getAttribute('aria-label'), 'Copy the Homebrew command');
  copyFails = true;
  await click(copy);
  assert.equal(copy.getAttribute('aria-label'), 'Copy the Homebrew command');
  await v.unmount();
});

test("lines this machine can't run are dimmed with why, keep Copy, and npm without Node.js links to it", async () => {
  await reset();
  await set({ tools: { npm: false, brew: false, npmWritable: null } });
  const v = await view();
  await others(v.host);
  const brew = lineOf(v.host, 'brew');
  assert.ok(brew.classList.contains('blocked'));
  assert.equal(brew.querySelector('.install-why')!.textContent, 'Needs Homebrew');
  assert.ok((byText(brew, 'Run') as HTMLButtonElement).disabled);
  assert.ok(brew.querySelector('.install-copy'));
  const npm = lineOf(v.host, 'npm');
  assert.match(npm.querySelector('.install-why')!.textContent!, /^Needs Node.js · nodejs.org ↗$/);
  await click(byText(npm, 'nodejs.org ↗'));
  assert.deepEqual(did(), [['open', 'https://nodejs.org/']]);
  assert.equal(lineOf(v.host, 'script').querySelector('.install-why'), null);
  await set({ tools: { npm: true, brew: true, npmWritable: false } });
  assert.equal(lineOf(v.host, 'npm').querySelector('.install-why')!.textContent, 'Needs admin rights');
  await v.unmount();
});

test('Run starts that line in main; a refusal or failure says why', async () => {
  await reset();
  const v = await view();
  await click(byText(lineOf(v.host, 'script'), 'Install'));
  assert.deepEqual(did(), [['start', 'acp:qwen', 0]]);
  await others(v.host);
  calls.length = 0;
  startResult = { ok: false, error: 'busy', by: 'acp:goose' };
  await click(byText(lineOf(v.host, 'brew'), 'Run'));
  startResult = { ok: false, error: 'spawn', message: 'no pty' };
  await click(byText(lineOf(v.host, 'brew'), 'Run'));
  startResult = { ok: false, error: 'unknown' };
  await click(byText(lineOf(v.host, 'brew'), 'Run'));
  startThrows = new Error('IPC down');
  await click(byText(lineOf(v.host, 'brew'), 'Run'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'toast'),
    [
      ['toast', "Another Homebrew install is running. Try again once it's done.", 'error'],
      ['toast', "Couldn't run brew install qwen-code: no pty", 'error'],
      ['toast', "Couldn't run brew install qwen-code", 'error'],
      ['toast', "Couldn't run brew install qwen-code: IPC down", 'error'],
    ],
  );
  await v.unmount();
});

test('while a run goes, its line says so, the others wait, its terminal is attached below, and Stop ends it', async () => {
  await reset();
  await set({ runs: [run()] });
  const v = await view();
  // a run of another way keeps the other ways open, and says how long it has taken
  assert.match(lineOf(v.host, 'brew').querySelector('.install-running')!.textContent!, /Installing… 0:0\d/);
  assert.equal(maybeText(lineOf(v.host, 'brew'), 'Run'), null);
  assert.ok((byText(lineOf(v.host, 'script'), 'Install') as HTMLButtonElement).disabled);
  assert.equal(maybeText(v.host, 'Taking long?'), null, 'not yet');
  const term = v.host.querySelector('[data-term]')!;
  assert.equal(term.getAttribute('data-term'), 'r1');
  assert.equal(term.getAttribute('data-attached'), 'true', "the view attaches to main's run");
  // its end comes from the run list, not the terminal
  await click(term);
  await click(byText(v.host, 'Stop'));
  assert.deepEqual(did(), [['stop', 'r1']]);
  await set({ runs: [run({ stopped: true })] });
  assert.match(lineOf(v.host, 'brew').querySelector('.install-running')!.textContent!, /Stopping…/);
  assert.ok(v.host.querySelector('[data-term]'), 'the terminal remains attached during cleanup');
  assert.equal((byText(lineOf(v.host, 'script'), 'Install') as HTMLButtonElement).disabled, true);
  // nothing is looked for in the background while a run goes: its end does that
  assert.equal(calls.filter((c) => c[0] === 'find').length, 0);
  await v.unmount();
});

test('a run past 90 s offers a way out: Stop, or Try another way, which stops it and runs the next line', async () => {
  await reset();
  await set({
    runs: [
      run({
        via: 'script',
        command: 'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash',
        group: null,
        startedAt: Date.now() - 91_000,
      }),
    ],
  });
  const v = await view();
  assert.match(lineOf(v.host, 'script').querySelector('.install-running')!.textContent!, /Installing… 1:3\d/);
  assert.match(v.host.querySelector('.install-foot')!.textContent!, /Taking long\?StopTry another way/);
  await click(byText(v.host, 'Try another way'));
  assert.deepEqual(did(), [
    ['stop', 'r1'],
    ['start', 'acp:qwen', 1],
  ]);
  // the next way is shown with the others
  assert.ok(lineOf(v.host, 'brew'));
  await v.unmount();
  // an update of a harness already there (Settings shows its run on the same card) is no install line: no other way
  await reset();
  await set({ runs: [run({ purpose: 'update', via: 'self', command: 'qwen update', group: null, startedAt: Date.now() - 91_000 })] });
  const u = await view({ state: 'present', version: '1.0.0' });
  assert.match(u.host.querySelector('.install-foot')!.textContent!, /^Taking long\?Stop$/);
  await u.unmount();
  // nor once the harness is found, though its install is still running
  await reset();
  await set({ runs: [run({ startedAt: Date.now() - 91_000 })] });
  const f = await view({ state: 'present' });
  assert.match(f.host.querySelector('.install-foot')!.textContent!, /^Taking long\?Stop$/);
  await f.unmount();
  // an install of a line this machine no longer lists (another window's, or a table since changed): no guess at the next
  await reset();
  await set({ runs: [run({ state: 'exited', code: 1, checked: true, command: 'brew install qwen-old' })], settled: { r1: true } });
  const gone = await view();
  assert.equal(maybeText(gone.host, 'Try another way'), null);
  assert.ok(byText(gone.host, 'Show output'));
  await gone.unmount();
  // the last way has none after it: Stop alone
  await reset();
  await set({
    runs: [run({ via: 'npm', command: 'npm install -g @qwen-code/qwen-code@latest', group: 'npm', startedAt: Date.now() - 91_000 })],
  });
  const w = await view();
  assert.match(w.host.querySelector('.install-foot')!.textContent!, /^Taking long\?Stop$/);
  await w.unmount();
});

test('an open install step looks for the harness in the background, and once its binary is there, looks again once', async () => {
  await reset();
  const v = await view();
  await act(async () => undefined);
  assert.deepEqual([...new Set(calls.map(String))], ['find,acp:qwen'], 'asked at once');
  await v.unmount();
  calls.length = 0;
  findResult = '/bin/qwen:1:1';
  const w = await view();
  await act(async () => undefined);
  await act(async () => undefined);
  assert.deepEqual(did(), [['recheckBasic', 'qwen']], 'looked for again once');
  await w.unmount();
  // a harness already found asks nothing
  calls.length = 0;
  const x = await view({ state: 'present' });
  await act(async () => undefined);
  assert.deepEqual(calls, []);
  await x.unmount();
});

test("another harness's run on the same package manager holds that line, and only that one", async () => {
  await reset();
  await set({ runs: [run({ id: 'g', kind: 'acp:goose' })] });
  const v = await view();
  await others(v.host);
  const brew = lineOf(v.host, 'brew');
  assert.ok((byText(brew, 'Run') as HTMLButtonElement).disabled);
  assert.equal((byText(brew, 'Run') as HTMLButtonElement).title, 'Another Homebrew install is running');
  assert.equal(brew.querySelector('.install-why')!.textContent, 'Another Homebrew install is running');
  assert.equal((byText(lineOf(v.host, 'npm'), 'Run') as HTMLButtonElement).disabled, false);
  assert.equal(v.host.querySelector('[data-term]'), null, "another harness's terminal isn't shown here");
  await v.unmount();
});

test('an ended run shows its output while the harness is looked for again', async () => {
  await reset();
  await set({ runs: [run({ state: 'exited', code: 0 })] });
  const v = await view();
  assert.ok(v.host.querySelector('[data-term]'));
  assert.match(v.host.querySelector('.install-outcome')!.textContent!, /Looking for Qwen Code…/);
  assert.equal(maybeText(v.host, 'Stop'), null);
  await v.unmount();
});

test('found once looked for: installed, with its version, and Done dismisses the result', async () => {
  await reset();
  await set({ runs: [run({ state: 'exited', code: 0, checked: true })], settled: { r1: true } });
  const v = await view({ state: 'present', version: '0.25.2' });
  assert.equal(v.host.querySelector('.install-outcome.ok')!.textContent, 'Qwen Code 0.25.2 installed.Done');
  // the card only reports now: no line runs again over the working install
  assert.ok(lines(v.host).every((l) => (l.querySelector('button.btn-pill:not(.install-copy)') as HTMLButtonElement).disabled));
  assert.equal(v.host.querySelector('[data-term]'), null);
  await click(byText(v.host, 'Done'));
  assert.deepEqual(did(), [['dismiss', 'r1']]);
  await v.unmount();
  const noVersion = await view({ state: 'present', version: null });
  assert.equal(noVersion.host.querySelector('.install-outcome.ok span')!.textContent, 'Qwen Code installed.');
  await noVersion.unmount();
});

test('exit 0 but not found where main looked: Re-check (whose failure says so) or Locate…', async () => {
  await reset();
  await set({ runs: [run({ state: 'exited', code: 0, checked: true })], settled: { r1: true } });
  const v = await view();
  assert.match(v.host.textContent!, /Qwen Code installed, but MoPilot can't find it yet\./);
  assert.doesNotMatch(v.host.textContent!, /PATH/);
  await click(byText(v.host, 'Locate…'));
  assert.deepEqual(located.splice(0), ['locate']);
  await click(byText(v.host, 'Re-check'));
  recheckFails = new Error('probe failed');
  await click(byText(v.host, 'Re-check'));
  await act(async () => undefined);
  assert.deepEqual(did(), [
    ['recheckBasic', 'qwen'],
    ['recheckBasic', 'qwen'],
    ['toast', "Couldn't check for Qwen Code: probe failed", 'error'],
  ]);
  await v.unmount();
});

test('a failed or stopped run says how it ended, offers the next way first, and its output is a click away', async () => {
  await reset();
  await set({ runs: [run({ state: 'exited', code: 1, checked: true })], settled: { r1: true } });
  const v = await view();
  // a sentence; the command and its exit code stay behind Show output (#1863)
  assert.match(v.host.textContent!, /Couldn't install Qwen Code\.Try another wayShow output/);
  assert.doesNotMatch(v.host.textContent!, /exited with code/);
  assert.equal(v.host.querySelector('[data-term]'), null, 'the output is hidden until asked for');
  await click(byText(v.host, 'Show output'));
  assert.ok(v.host.querySelector('[data-term]'));
  // Homebrew failed: npm is next
  await click(byText(v.host.querySelector('.install-outcome')!, 'Try another way'));
  assert.deepEqual(did(), [['start', 'acp:qwen', 2]]);
  // a new run hides the old output again
  await set({ runs: [run({ id: 'r2', state: 'exited', code: null, stopped: true, checked: true })], settled: { r2: true } });
  assert.match(v.host.textContent!, /Stopped installing Qwen Code\./);
  assert.equal(v.host.querySelector('[data-term]'), null);
  await v.unmount();
});

// A valid empty methods list still has a complete install path in the real shared component.
test('without one-line commands: explain the ACP server, open vendor docs, and set its location', async () => {
  await reset();
  located.length = 0;
  const v = await view({ kind: 'acp:antigravity', label: 'Antigravity', vendor: 'Google' });
  assert.match(v.host.textContent!, /localharness_external/);
  assert.equal(lines(v.host).length, 0);
  assert.equal(v.host.querySelector('[data-term]'), null);
  await click(byText(v.host, 'Get it from Google ↗'));
  assert.deepEqual(did(), [['open', 'https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp']]);
  await click(byText(v.host, 'Set location…'));
  assert.deepEqual(located, ['locate']);
  await v.unmount();
});
