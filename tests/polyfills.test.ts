import { test } from 'node:test';
import assert from 'node:assert/strict';

const init = await import('../src/harness/polyfills/init.ts');
const shell = await import('../src/harness/polyfills/shell.ts');

test('init: Codex is polyfilled; Claude only gets a plan when AGENTS.md can be offered', () => {
  assert.equal(init.planInit('claude', { agents: false, claude: true }), null);
  assert.equal(init.planInit('claude', { agents: true, claude: true, pointed: true }), null);
  const c = init.planInit('claude', { agents: true, claude: false })!;
  assert.equal(c.prompt, '/init');
  assert.equal(c.confirmOverwrite, null);
  assert.equal(c.offer!.pointer, '@AGENTS.md');
  assert.match(c.offer!.text, /AGENTS\.md exists · Let Claude Code read it too \(adds one line to CLAUDE\.md\)/);
  assert.equal(init.initPrompt(c, true), '/init');
  assert.equal(init.planInit('acp:kimi', { agents: false, claude: false }), null);
  const p = init.planInit('codex', { agents: false, claude: false })!;
  assert.equal(p.file, 'AGENTS.md');
  assert.equal(p.confirmOverwrite, null);
  assert.equal(p.offer, null);
  assert.match(p.prompt, /AGENTS\.md/);
});

test("init: the / menu's line names the file and harness of the chat it runs in, not Codex's on every harness", () => {
  assert.equal(init.initDesc('codex'), 'Create AGENTS.md with instructions for Codex');
  assert.equal(init.initDesc('claude'), 'Create CLAUDE.md with instructions for Claude Code');
});

test('init: existing AGENTS.md asks first; existing CLAUDE.md offers a pointer', () => {
  const p = init.planInit('codex', { agents: true, claude: true })!;
  assert.match(p.confirmOverwrite!, /AGENTS\.md already exists/);
  assert.equal(p.offer!.other, 'CLAUDE.md');
  assert.match(p.offer!.text, /CLAUDE\.md exists/);
});

test('init: pointer lines are added once, in each direction', () => {
  assert.equal(init.pointerLine('claude'), '@AGENTS.md');
  const a = init.withPointer('# Rules\n\n', 'claude');
  assert.equal(a, '# Rules\n\n@AGENTS.md\n');
  assert.equal(init.withPointer(a, 'claude'), a);
  const b = init.withPointer('', 'codex');
  assert.equal(b, 'Also follow the instructions in CLAUDE.md.\n');
  assert.ok(init.hasPointer(b, 'codex'));
  assert.ok(!init.hasPointer(b, 'claude'));
});

test('shell: parseBang', () => {
  assert.deepEqual(shell.parseBang('!ls -la'), { cmd: 'ls -la' });
  assert.deepEqual(shell.parseBang('  !git status \n'), { cmd: 'git status' });
  for (const t of ['!', '! ls', '!!', 'hi !ls', '/init']) assert.equal(shell.parseBang(t), null);
});

test('shell: cleanOutput strips escapes and carriage-return redraws', () => {
  assert.equal(shell.cleanOutput('\u001b[32mok\u001b[0m\r\nline\r\n'), 'ok\nline');
  assert.equal(shell.cleanOutput('10%\r50%\r100%\r\n'), '100%');
});

test('shell: attachment carries the sandbox note, status and a truncated tail', () => {
  const a = shell.shellAttachment({ cmd: 'ls', cwd: '/w', output: 'a\r\nb\r\n', exitCode: 0 });
  assert.equal(a.text, "$ ls\n(Ran on this Mac, outside Claude Code's sandbox · /w · exit 0)\n\na\nb");
  const f = shell.shellAttachment({ cmd: 'x', cwd: '/w', output: '', exitCode: 2 });
  assert.match(f.text, /exit 2/);
  assert.match(f.text, /\(no output\)/);
  const long = shell.shellAttachment({ cmd: 'x', cwd: '/w', output: 'a'.repeat(100_000) + 'END', exitCode: 0 });
  assert.match(long.text, /truncated/);
  assert.ok(long.text.endsWith('END'));
});

test("shell: runShell's pty answers ConPTY's start-up question itself, since no view answers for it", async () => {
  let opts: any;
  let cb: any;
  const pty = {
    spawn: async (id: string, o: unknown) => {
      opts = o;
      setImmediate(() => cb({ id, type: 'exit', exitCode: 0 }));
    },
    kill: async () => true,
    onEvent: (f: any) => ((cb = f), () => {}),
  };
  await shell.runShell(pty, 'true', '/w');
  assert.equal(opts.selfAnswer, true);
});

test('shell: runShell collects output until exit, and times out', async () => {
  const fake = (script: (id: string, emit: (e: any) => void) => void) => {
    let cb: any;
    return {
      spawn: async (id: string) => void setImmediate(() => script(id, (e) => cb(e))),
      kill: async () => true,
      onEvent: (f: any) => ((cb = f), () => {}),
    };
  };
  const ok = await shell.runShell(
    fake((id, emit) => {
      emit({ id: 'other', type: 'data', data: 'noise' });
      emit({ id, type: 'data', data: 'hi\r\n' });
      emit({ id, type: 'exit', exitCode: 0 });
    }),
    'echo hi',
    '/w',
  );
  assert.equal(ok.output, 'hi\r\n');
  assert.equal(ok.exitCode, 0);
  const slow = await shell.runShell(
    fake(() => {}),
    'sleep 9',
    '/w',
    { timeoutMs: 20 },
  );
  assert.equal(slow.timedOut, true);
  assert.match(shell.shellAttachment(slow).text, /timed out/);
});

test('shell: runShell runs the line through sh, or PowerShell on Windows, which has no /bin/sh', async () => {
  assert.deepEqual(shell.oneShot('echo hi', undefined, false), ['/bin/sh', '-c', 'echo hi']);
  assert.deepEqual(shell.oneShot('echo hi', undefined, true), ['powershell.exe', '-NoLogo', '-NoProfile', '-Command', 'echo hi']);
  assert.deepEqual(shell.oneShot('echo hi', '/bin/bash', true), ['/bin/bash', '-c', 'echo hi']);
  // the pty is given that line, for the platform runShell is told, else this one (no bridge here: macOS)
  const spawned: string[][] = [];
  let cb: any;
  const pty = {
    spawn: async (id: string, o: { command: string[] }) => {
      spawned.push(o.command);
      setImmediate(() => cb({ id, type: 'exit', exitCode: 0 }));
    },
    kill: async () => true,
    onEvent: (f: any) => ((cb = f), () => {}),
  };
  await shell.runShell(pty, 'echo hi', '/w', { win: true });
  await shell.runShell(pty, 'echo hi', '/w', { win: false });
  await shell.runShell(pty, 'echo hi', '/w');
  assert.deepEqual(spawned, [
    ['powershell.exe', '-NoLogo', '-NoProfile', '-Command', 'echo hi'],
    ['/bin/sh', '-c', 'echo hi'],
    ['/bin/sh', '-c', 'echo hi'],
  ]);
});

test('initPrompt adds the pointer line only when the offer was accepted', async () => {
  const { planInit, initPrompt } = init;
  const plan = planInit('codex', { agents: false, claude: true })!;
  assert.equal(initPrompt(plan, false), plan.prompt);
  assert.match(initPrompt(plan, true), /Also follow the instructions in CLAUDE\.md\.$/);
  const none = planInit('codex', { agents: false, claude: false })!;
  assert.equal(initPrompt(none, true), none.prompt);
});
