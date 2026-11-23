// How a Codex copy that keeps quitting is named (src/harness/codexQuit.ts): its build and where it came from, the
// sentence when it is the user's own pick, the switch to another copy, and the crash output to copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexCopyName, codexQuitText, codexSwitchedText, codexCrashOutput } from '../src/harness/codexQuit.ts';
const copy = (o: Partial<{ path: string; version: string | null; via: string | null; from: string | null }>) => ({
  path: '/x/codex',
  version: null,
  via: null,
  from: null,
  ...o,
});

test('a copy is named by its build and where it came from, as far as main knows them', () => {
  for (const [c, name] of [
    [copy({ version: '0.163.0-alpha.10.2', via: 'app-bundle', from: 'ChatGPT.app' }), 'Codex 0.163.0-alpha.10.2 from ChatGPT.app'],
    [copy({ via: 'app-bundle' }), 'Codex bundled with an app'],
    [copy({ version: '0.162.0', via: 'brew' }), 'Codex 0.162.0 from Homebrew'],
    [copy({ via: 'npm' }), 'Codex from npm'],
    [copy({ via: 'pnpm' }), 'Codex from pnpm'],
    [copy({ via: 'self' }), 'Codex from its installer'],
    [copy({ path: '/Users/me/bin/codex', via: 'unknown' }), 'Codex at ~/bin/codex'],
    [copy({ path: 'C:\\Users\\me\\codex.exe' }), 'Codex at ~\\codex.exe'],
    // plain "codex" left to PATH: nothing more to say
    [copy({ path: 'codex' }), 'Codex'],
  ] as const)
    assert.equal(codexCopyName(c), name);
});

test("the sentences: keeps quitting (and kept when it is the user's pick), the switch, and the crash output", () => {
  const alpha = copy({ version: '0.163.0-alpha.10.2', via: 'app-bundle', from: 'ChatGPT.app' });
  const stable = copy({ path: '/opt/homebrew/bin/codex', version: '0.162.0', via: 'brew' });
  assert.equal(codexQuitText({ copy: alpha, pinned: false }), 'Codex 0.163.0-alpha.10.2 from ChatGPT.app keeps quitting.');
  assert.match(codexQuitText({ copy: alpha, pinned: true }), /keeps quitting\. It's the copy you picked, so MoPilot keeps using it\.$/);
  assert.equal(
    codexSwitchedText(alpha, stable),
    'Codex 0.163.0-alpha.10.2 from ChatGPT.app kept quitting, so MoPilot is using Codex 0.162.0 from Homebrew instead.',
  );
  assert.equal(
    codexCrashOutput({ copy: stable, pinned: false }, 'exited (1)'),
    'Codex 0.162.0 from Homebrew (/opt/homebrew/bin/codex)\nexited (1)',
  );
  assert.equal(codexCrashOutput(null, 'exited (1)'), 'exited (1)');
  assert.equal(codexCrashOutput({ copy: stable, pinned: false }, null), 'Codex 0.162.0 from Homebrew (/opt/homebrew/bin/codex)');
});
