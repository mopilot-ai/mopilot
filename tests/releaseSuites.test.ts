// scripts/release-suites.cjs: the release-only suites refuse to start outside a release, and the Claude Code hook blocks agents from starting them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/release-suites.cjs');
const {
  insideVirtualMachine,
  releaseAllowed,
  requireRelease,
  runsInVirtualMachine,
  runsOnCiRunners,
  startsReleaseSuite,
  claudeHookDecision,
  main,
} = require(SCRIPT);

const call = (command: unknown) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
// a desktop: the machine running these tests may itself be a virtual machine (GitHub's macOS runners are)
const desktop = () => false;

test('a release-only suite runs for a release or on a GitHub Actions runner, nowhere else', () => {
  assert.equal(releaseAllowed({ MOPILOT_RELEASE: '1' }), true);
  assert.equal(releaseAllowed({ GITHUB_ACTIONS: 'true' }), true);
  assert.equal(releaseAllowed({}, desktop), false);
  assert.equal(releaseAllowed({ MOPILOT_RELEASE: 'true', CI: 'true' }, desktop), false);
  assert.equal(releaseAllowed(), process.env.MOPILOT_RELEASE === '1' || process.env.GITHUB_ACTIONS === 'true' || insideVirtualMachine());
});

test('an isolated macOS virtual machine may run a suite; the hypervisor flag decides, and a desktop never passes', () => {
  assert.equal(
    releaseAllowed({}, () => true),
    true,
  );
  assert.equal(
    releaseAllowed({}, () => false),
    false,
  );
  assert.equal(insideVirtualMachine({ platform: 'darwin', sysctl: () => '1\n' }), true);
  assert.equal(insideVirtualMachine({ platform: 'darwin', sysctl: () => '0\n' }), false);
  assert.equal(
    insideVirtualMachine({
      platform: 'darwin',
      sysctl: () => {
        throw new Error('unknown oid');
      },
    }),
    false,
  );
  assert.equal(insideVirtualMachine({ platform: 'linux', sysctl: () => '1' }), false);
  assert.equal(typeof insideVirtualMachine(), 'boolean');
  assert.doesNotThrow(() => requireRelease('The E2E suite', 'launches real MoPilot windows', {}, () => true));
  assert.equal(
    claudeHookDecision(call('npm run test:e2e'), {}, () => true),
    null,
  );
});

test('a suite handed to the virtual machine is let through; anything that would also run here is not', () => {
  for (const command of [
    'scripts/vm-exec.sh npm run test:e2e',
    './scripts/vm-exec.sh npx playwright test -c tests/e2e',
    'scripts/vm-exec.sh zsh -lc "cd ~/mopilot && MOPILOT_RELEASE=1 npm run conformance -- --harness claude"',
    'scripts/vm-exec.sh zsh -lc "cd ~/mopilot && node bench/run.mjs --bench wg --arm mp-claude --run pr-123"',
    'scripts/vm-exec.sh',
    'scripts/vm-exec.sh --vm mopilot-cuj zsh /Users/admin/cuj-run.sh',
  ]) {
    assert.equal(runsInVirtualMachine(command), true, command);
    assert.equal(startsReleaseSuite(command), false, command);
    assert.equal(
      claudeHookDecision(call(command), {}, () => false),
      null,
      command,
    );
  }
  for (const command of [
    'scripts/vm-exec.sh true; npm run test:e2e',
    'scripts/vm-exec.sh true && npm run test:e2e',
    'scripts/vm-exec.sh true | npm run test:e2e',
    'scripts/vm-exec.sh echo "$(npm run test:e2e)"',
    'scripts/vm-exec.sh echo `npm run test:e2e`',
    'scripts/vm-exec.sh true\nnpm run test:e2e',
    'cd x && scripts/vm-exec.sh npm run test:e2e',
    'scripts/vm-exec.shx npm run test:e2e',
  ]) {
    assert.equal(runsInVirtualMachine(command), false, command);
    assert.equal(startsReleaseSuite(command), true, command);
  }
});

test('specs handed to the CI runners are let through like the virtual machine; anything that would also run here is not', () => {
  for (const command of [
    "node scripts/ci-cuj.mjs --branch my-fix --spec 'cuj-claude*' --shards 2",
    'node ./scripts/ci-cuj.mjs --sha 0123abc --spec "tests/e2e/*.spec.ts"',
    // a spec path that names a suite script is only an argument
    'node scripts/ci-cuj.mjs --spec tests/e2e/downgrade.spec.ts',
  ]) {
    assert.equal(runsOnCiRunners(command), true, command);
    assert.equal(runsInVirtualMachine(command), false, command);
    assert.equal(startsReleaseSuite(command), false, command);
    assert.equal(claudeHookDecision(call(command), {}, desktop), null, command);
  }
  for (const command of [
    "node scripts/ci-cuj.mjs --spec 'x'; npm run test:e2e",
    "node scripts/ci-cuj.mjs --spec 'x' && npx playwright test -c tests/e2e",
    'node scripts/ci-cuj.mjs --spec "$(npm run test:e2e)"',
    'node scripts/ci-cuj.mjs --spec `npm run test:e2e`',
    'MOPILOT_RELEASE=1 node scripts/ci-cuj.mjs --spec x',
    'node scripts/ci-cuj.mjsx npm run test:e2e',
  ]) {
    assert.equal(runsOnCiRunners(command), false, command);
    assert.equal(startsReleaseSuite(command), true, command);
  }
});

test('the gate explains what the suite does, the unit tests to run instead, and who may switch it on', () => {
  assert.doesNotThrow(() => requireRelease('The E2E suite', 'launches real MoPilot windows on this computer', { MOPILOT_RELEASE: '1' }));
  assert.throws(
    () => requireRelease('The E2E suite', 'launches real MoPilot windows on this computer', {}, desktop),
    (e: Error) =>
      /^The E2E suite is release-only: it launches real MoPilot windows on this computer, so AGENTS\.md/.test(e.message) &&
      e.message.includes('npm run test:coverage -- --changed --related') &&
      e.message.includes('agents never set that themselves') &&
      e.message.includes('node scripts/ci-cuj.mjs'),
  );
  if (!releaseAllowed()) assert.throws(() => requireRelease('The conformance suite', 'drives the real CLIs'), /release-only/);
});

test('commands that start a suite, or switch the gate off, are recognised', () => {
  for (const command of [
    'npm run test:e2e',
    'npm run -s test:e2e -- --shard=1/4',
    'cd repo && npm run test:downgrade',
    'npm run conformance -- --harness claude',
    'pnpm test:e2e',
    'yarn run conformance',
    'npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/cuj-codex.spec.ts',
    'node_modules/.bin/playwright test --list',
    'node tests/conformance/run.mjs --harness codex',
    'node scripts/chrome-compare/run.mjs --user-data-dir /tmp/s --app .',
    'node scripts/perf-bench/run.mjs --scenarios S1 --out /tmp/p',
    'node bench/run.mjs --bench wg --arm mp-claude',
    'cd ~/mopilot && node bench/mac-validate.mjs a13331ed',
    'zsh bench/vm-grant.sh',
    'node bench/setup-external.mjs',
    'node bench/edge-run.mjs --cells codex --run edge1',
    'node bench/contract-run.mjs --harness claude --version 2.1.296',
    'cd ~/mopilot && node bench/contract-nightly.mjs',
    'node tests/conformance/acp/sage-permission.mjs --out /tmp/g9 copilot',
    'MGB_TOKEN=x node bench/mgb-run.mjs --tier smoke --run mgb1',
    'node bench/mgb-limit-proxy.mjs 8830',
    'node bench/motion-record.mjs --arm desk-claude --moment turn-start --run m1',
    'node scripts/smoke-launch.mjs "out/MoPilot-darwin-arm64/MoPilot.app"',
    'node scripts/win-containment.mjs "C:\\Users\\me\\AppData\\Local\\Programs\\MoPilot"',
    'MOPILOT_RELEASE=1 npx vite build',
    'export MOPILOT_RELEASE=1; echo ok',
    '(MOPILOT_RELEASE=1 make)',
    'npm run --silent test:e2e',
    'npm -s run test:downgrade',
    'npm --prefix . run conformance -- --harness codex',
    'npx playwright@1.63.0 test -c tests/e2e',
    // text handed to another shell is code
    'zsh -lc "npx playwright test -c tests/e2e"',
    "bash -c 'npm run test:e2e'",
    "sh <<'EOF'\nnpm run conformance\nEOF",
    'eval "MOPILOT_RELEASE=1 true"',
  ]) {
    assert.equal(startsReleaseSuite(command), true, command);
  }
});

test('commands that only name a suite in quoted text, a here-document or another script are let through', () => {
  for (const command of [
    'npm test',
    'node bench/report.mjs bench/results/smoke1 --before bench/results/base',
    'node bench/motion-metrics.mjs --self-check',
    'node bench/edge-serve.mjs 8790',
    'npm run test:coverage -- --changed --related',
    'npm run test:related -- tests/e2e/playwright.config.ts',
    'grep -rn "playwright test" docs',
    "git commit -m 'Gate npm run test:e2e behind MOPILOT_RELEASE=1'",
    'git commit -m "Gate \\"npm run conformance\\" too"',
    "gh pr create --body-file - <<'EOF'\nRegression suites (npm run test:e2e, MOPILOT_RELEASE=1) were not run.\nEOF",
    'cat <<-EOF > notes.md\n\tnpx playwright test\n\tEOF\necho done',
    'echo $MOPILOT_RELEASE',
    'npm run playwright-report',
    // they skip the e2e without MOPILOT_RELEASE=1
    'scripts/handoff/health.sh origin/main',
    'git commit -m "npm run test:e2e" && scripts/handoff/health.sh',
    'npm run test:related -- tests/e2e/fixtures/app.ts; git log --grep conformance',
  ]) {
    assert.equal(startsReleaseSuite(command), false, command);
  }
  // text after a here-document still counts
  assert.equal(startsReleaseSuite("cat <<'EOF' > x\nhello\nEOF\nnpm run test:e2e"), true);
});

test('the hook denies a suite outside a release and lets everything else through', () => {
  const denied = claudeHookDecision(call('npm run test:e2e'), {}, desktop);
  assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /release-only suite .* takes over the user’s computer/);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /ask them to start it themselves with MOPILOT_RELEASE=1/);
  // a session the user started for a release
  assert.equal(claudeHookDecision(call('npm run test:e2e'), { MOPILOT_RELEASE: '1' }), null);
  assert.equal(claudeHookDecision(call('npm test'), {}, desktop), null);
  // not a shell command, or not JSON at all: nothing to decide
  assert.equal(claudeHookDecision(JSON.stringify({ tool_input: { url: 'x' } }), {}, desktop), null);
  assert.equal(claudeHookDecision(call(42), {}, desktop), null);
  assert.equal(claudeHookDecision('null', {}, desktop), null);
  assert.equal(claudeHookDecision('{', {}, desktop), null);
  if (!releaseAllowed()) assert.notEqual(claudeHookDecision(call('npm run test:e2e')), null);
});

test('main prints the decision for --claude-hook and refuses anything else', () => {
  const out: string[] = [];
  const write = (t: string) => out.push(t);
  const decision = main({ argv: ['--claude-hook'], read: () => call('npm run conformance'), write, env: {}, inVm: desktop });
  assert.deepEqual(JSON.parse(out[0]), decision);
  assert.equal(main({ argv: ['--claude-hook'], read: () => call('ls'), write, env: {}, inVm: desktop }), null);
  assert.equal(out.length, 1);
  assert.throws(
    () => main({ argv: [], read: () => '', write, env: {}, inVm: desktop }),
    /usage: node scripts\/release-suites\.cjs --claude-hook/,
  );
});

test('as Claude Code runs it: the tool call on stdin, the decision on stdout', () => {
  const env = { ...process.env, MOPILOT_RELEASE: '', GITHUB_ACTIONS: '' };
  const run = (input: string) => spawnSync(process.execPath, [SCRIPT, '--claude-hook'], { input, env, encoding: 'utf8' });
  const blocked = run(call('npx playwright test -c tests/e2e'));
  assert.equal(blocked.status, 0);
  // in a virtual machine (a GitHub macOS runner) the suite may run, so there is nothing to deny
  if (insideVirtualMachine()) assert.equal(blocked.stdout, '');
  else assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const allowed = run(call('git status'));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');
});
