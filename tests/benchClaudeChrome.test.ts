// Claude in Chrome stays off in benchmark runs unless a run pairs one inside the VM (#1561): the flags every bench
// instance gets (bench/lib/claudeChrome.mjs), the vendor arms' stop, and a whole-repository check that every MoPilot
// instance a bench or contract run starts goes through benchFlags and every README recipe turns it off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const GUARDS = ['bench/', 'scripts/'];

const { PAIRING_ENV, CLAUDE_CHROME_OFF, vmLocalPairing, benchFlags, vendorChromeAllowed } = await import('../bench/lib/claudeChrome.mjs');

const root = new URL('..', import.meta.url).pathname;
const PAIRED = { [PAIRING_ENV]: 'vm-local' };

test("benchFlags turns Claude in Chrome off and keeps the run's other switches", () => {
  assert.equal(CLAUDE_CHROME_OFF, 'native.claude.chrome=0');
  assert.equal(benchFlags(undefined, {}), 'native.claude.chrome=0');
  assert.equal(benchFlags('', {}), 'native.claude.chrome=0');
  assert.equal(
    benchFlags('shared.browser.chromeRelay=0, codex.browser.chromeExtension=0', {}),
    'shared.browser.chromeRelay=0,codex.browser.chromeExtension=0,native.claude.chrome=0',
  );
  // a run that turned it on (the comparison's native arm) still gets it off without a VM-local pairing
  assert.equal(benchFlags('native.claude.chrome=1,a=1', {}), 'a=1,native.claude.chrome=0');
  assert.equal(benchFlags(' native.claude.chrome = 1 ', {}), 'native.claude.chrome=0');
});

test('a run that declared a VM-local pairing keeps its own setting, and only "vm-local" declares it', () => {
  assert.equal(benchFlags('native.claude.chrome=1,a=1', PAIRED), 'native.claude.chrome=1,a=1');
  assert.equal(benchFlags(undefined, PAIRED), '');
  assert.equal(vmLocalPairing(PAIRED), true);
  for (const v of [undefined, '', '1', 'true', 'VM-LOCAL', ' vm-local'])
    assert.equal(vmLocalPairing({ [PAIRING_ENV]: v }), false, String(v));
});

test("vendorChromeAllowed: Claude Desktop's Claude in Chrome only with a VM-local pairing; other vendors as the task says", () => {
  assert.equal(vendorChromeAllowed({ transcripts: 'claude' }, {}), false);
  assert.equal(vendorChromeAllowed({ transcripts: 'claude' }, PAIRED), true);
  assert.equal(vendorChromeAllowed({ transcripts: 'codex' }, {}), true);
});

/** Tracked and untracked JavaScript under bench/ and scripts/ holding `text`. */
function filesWith(text: string) {
  const found = spawnSync(
    'git',
    ['grep', '-l', '--untracked', '-F', text, '--', 'bench/*.mjs', 'bench/*.js', 'scripts/*.mjs', 'scripts/*.js', 'scripts/*.cjs'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.ok(found.status === 0 || found.status === 1, found.stderr);
  return String(found.stdout).split('\n').filter(Boolean);
}

// instances that start no real Claude session, so Claude in Chrome cannot connect
const NO_REAL_CLAUDE: Record<string, string> = {
  'scripts/perf-bench/driver.mjs': 'runs a fake Claude Code (CLAUDE_BIN fake-claude.mjs) in its own config folder',
};

test('every MOPILOT_FLAGS a bench or contract run gives an instance goes through benchFlags', () => {
  const unguarded = filesWith('MOPILOT_FLAGS:').filter((f) => {
    if (NO_REAL_CLAUDE[f]) return false;
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    return src.split('\n').some((line) => /MOPILOT_FLAGS:/.test(line) && !/MOPILOT_FLAGS:\s*benchFlags\(/.test(line));
  });
  assert.deepEqual(
    unguarded,
    [],
    'set MOPILOT_FLAGS: benchFlags(...) (bench/lib/claudeChrome.mjs) so Claude in Chrome stays off in the VM',
  );
  // an instance a run starts with the attended switch is a bench instance: it sets its flags too
  const attended = filesWith("MOPILOT_BENCH_ATTENDED: '1'").filter(
    (f) => !/MOPILOT_FLAGS:\s*benchFlags\(/.test(fs.readFileSync(path.join(root, f), 'utf8')),
  );
  assert.deepEqual(attended, [], 'a bench instance with MOPILOT_BENCH_ATTENDED also needs MOPILOT_FLAGS: benchFlags(...)');
});

test("bench/README.md's instance recipes turn Claude in Chrome off", () => {
  const readme = fs.readFileSync(path.join(root, 'bench/README.md'), 'utf8');
  const recipes = readme.split('\n').filter((line) => /MOPILOT_BENCH_ATTENDED=1/.test(line) && /electron \./.test(line));
  assert.ok(recipes.length >= 3, 'the README still has its instance recipes');
  for (const line of recipes) assert.match(line, /MOPILOT_FLAGS=native\.claude\.chrome=0/, line.trim());
});
