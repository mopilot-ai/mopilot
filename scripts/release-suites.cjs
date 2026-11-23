// Keeps the release-only suites (E2E, downgrade, conformance, benchmarks) to releases: their gate, and the Claude Code hook that blocks agents from starting them or MoPilot itself on this computer.
// These suites launch real MoPilot windows or drive the real harness CLIs on the machine they run on, so AGENTS.md runs
// them only as part of a release. Set MOPILOT_RELEASE=1 to run one; a GitHub Actions runner and an isolated virtual
// machine are nobody's desktop and may. Agents reach those through scripts/vm-exec.sh (the VMs) and scripts/ci-cuj.mjs
// (GitHub Actions' macOS runners), which the hook lets through.
const { readFileSync } = require('node:fs');
const { launchesAppHere, HOST_APP_REASON } = require('./host-app-launch.cjs');

/** @typedef {Record<string, string | undefined>} Env */

const { execFileSync } = require('node:child_process');
// the one VM check, shared with the app's VM-only bench switch (electron/platform/virtualMachine.cjs)
const { VM_SYSCTL, SYSCTL, vmFromProbe } = require('../electron/platform/virtualMachine.cjs');

/**
 * Whether this is a macOS virtual machine, probed synchronously for the scripts and suites that gate on it (the app
 * probes without blocking: probeVirtualMachine). The host's hypervisor sets the flag, so a desktop cannot pass for one.
 * @param {{ platform?: string, sysctl?: () => string }} [deps]
 */
function insideVirtualMachine({ platform = process.platform, sysctl = () => execFileSync(SYSCTL, VM_SYSCTL, { encoding: 'utf8' }) } = {}) {
  return vmFromProbe(platform, sysctl);
}

/** Whether a release-only suite may run here. @param {Env} [env] @param {() => boolean} [inVm] */
function releaseAllowed(env = process.env, inVm = insideVirtualMachine) {
  return env.MOPILOT_RELEASE === '1' || env.GITHUB_ACTIONS === 'true' || inVm();
}

/**
 * Throws, saying why, unless a release-only suite may run here.
 * @param {string} suite what the suite is, e.g. "The E2E suite"
 * @param {string} effect what it does here, e.g. "launches real MoPilot windows on this computer"
 * @param {Env} [env]
 * @param {() => boolean} [inVm]
 */
function requireRelease(suite, effect, env = process.env, inVm = insideVirtualMachine) {
  if (releaseAllowed(env, inVm)) return;
  throw new Error(
    `${suite} is release-only: it ${effect}, so AGENTS.md runs it only as part of a release. ` +
      'Run the focused unit tests instead (npm run test:coverage -- --changed --related). ' +
      'For a release, the user starts it with MOPILOT_RELEASE=1; agents never set that themselves, and run it in the ' +
      'isolated virtual machine (scripts/vm-exec.sh) or on CI runners (node scripts/ci-cuj.mjs) instead.',
  );
}

/** Commands that start a release-only suite, or switch the gate off for one. */
const SUITE_COMMANDS = [
  /\bplaywright(?:@\S+)?\s+test\b/,
  // the script name anywhere in the same simple command: npm run -s, npm --prefix . run, pnpm test:e2e
  /\b(?:npm|pnpm|yarn)\b[^;&|\n]*?\s(?:test:e2e|test:downgrade|conformance)\b/,
  /\btests\/conformance\/run\.mjs\b/,
  // the ACP permission-card check (#1319 G9): one prompted turn per installed ACP harness
  /\btests\/conformance\/acp\/sage-permission\.mjs\b/,
  // the Chrome comparison (scripts/chrome-compare): real harnesses driving a scratch Chrome
  /\bscripts\/chrome-compare\/run\.mjs\b/,
  // the streaming benchmark (scripts/perf-bench): a scratch MoPilot instance driven over its debugging port
  /\bscripts\/perf-bench\/run\.mjs\b/,
  // the motion capture (#1511): a scratch instance on each family's fake, driven over its debugging port
  /\bscripts\/motion-cdp\/run\.mjs\b/,
  // the IAB/CU/BU benchmark runs, the edge-case scenario suite, the harness version contract and its nightly, the
  // 12-Grid Bench runs and its provider proxy, and the VM permission grant (bench/README.md)
  /\bbench\/(?:run|mac-validate|setup-external|edge-run|contract-run|contract-nightly|mgb-run|mgb-limit-proxy|motion-record)\.mjs\b/,
  /\bbench\/vm-grant\.sh\b/,
  // the packaged app's smoke launch (scripts/smoke-launch.mjs), run by the release workflow
  /\bscripts\/smoke-launch\.mjs\b/,
  // the Windows containment check (scripts/win-containment.mjs): the installed app with a fake harness, on a runner
  /\bscripts\/win-containment\.mjs\b/,
  /(?:^|[\s;&|("'])(?:export\s+)?MOPILOT_RELEASE=/,
];

/**
 * A command that hands text to another shell (bash -c "…", sh <<EOF, eval '…') or substitutes a command inside quotes
 * ("$(…)", `…`), where quoted text is code.
 */
const SHELL_INPUT = /(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh|eval)\s|\$\(|`/;

/**
 * Whether a shell command is only `launcher` and its arguments, with no second command, pipe, redirection or
 * substitution that would run on this computer. Quoted arguments (spec globs) never expand here.
 * @param {string} command @param {string} launcher a regular expression source for the command's start
 */
function onlyRuns(command, launcher) {
  if (/`|\$\(/.test(command)) return false;
  const code = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  return new RegExp(`^\\s*${launcher}(?:[ \\t][^;&|\\n<>()]*)?$`).test(code);
}

/** Whether a shell command only hands its arguments to the isolated virtual machine (scripts/vm-exec.sh). @param {string} command */
function runsInVirtualMachine(command) {
  return onlyRuns(command, String.raw`(?:\.\/)?scripts\/vm-exec\.sh`);
}

/** Whether a shell command only starts specs on GitHub Actions' macOS runners (scripts/ci-cuj.mjs). @param {string} command */
function runsOnCiRunners(command) {
  return onlyRuns(command, String.raw`node[ \t]+(?:\.\/)?scripts\/ci-cuj\.mjs`);
}

/**
 * Whether a shell command starts a release-only suite on this computer. Here-documents and quoted text are left out first, so a commit
 * message, PR body or search that only names one of these commands is not mistaken for running it, unless the
 * command hands that text to another shell.
 * @param {string} command
 */
function startsReleaseSuite(command) {
  if (runsInVirtualMachine(command) || runsOnCiRunners(command)) return false;
  if (SHELL_INPUT.test(command)) return SUITE_COMMANDS.some((re) => re.test(command));
  const code = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s*$)/gm, '').replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  return SUITE_COMMANDS.some((re) => re.test(code));
}

const DENY_REASON =
  'Blocked by the repository hook (.claude/settings.json): this command starts a release-only suite (E2E, downgrade, ' +
  'conformance, the Chrome comparison or a benchmark), which takes over the user’s computer. AGENTS.md runs these only ' +
  'as part of a release. Run the focused unit tests instead (npm run test:coverage -- --changed --related). If the user ' +
  'asked for this run, start it in the isolated virtual machine with scripts/vm-exec.sh <command> (fake-based E2E/CUJ ' +
  'specs also on CI runners: node scripts/ci-cuj.mjs --branch <b> --spec <glob>), or ask them to ' +
  'start it themselves with MOPILOT_RELEASE=1, or to start this session with ' +
  'MOPILOT_RELEASE=1 set.';

/**
 * Whether a shell command starts MoPilot on this computer rather than in the virtual machine or on the CI runners.
 * @param {string} command
 */
function startsHostApp(command) {
  if (runsInVirtualMachine(command) || runsOnCiRunners(command)) return false;
  return launchesAppHere(command, SHELL_INPUT);
}

/**
 * The Claude Code PreToolUse hook's answer for one tool call: a deny decision, or null to let it through: a
 * release-only suite, or MoPilot started on this computer for a check (AGENTS.md keeps both off the user's Mac).
 * @param {string} input the hook's stdin, JSON with tool_input.command
 * @param {Env} [env] the hook's own environment, which a release session sets MOPILOT_RELEASE=1 in
 * @param {() => boolean} [inVm]
 */
function claudeHookDecision(input, env = process.env, inVm = insideVirtualMachine) {
  if (releaseAllowed(env, inVm)) return null;
  let command;
  try {
    command = JSON.parse(input)?.tool_input?.command;
  } catch {
    // not a tool call this hook understands; let Claude Code carry on
    return null;
  }
  if (typeof command !== 'string') return null;
  const reason = startsReleaseSuite(command) ? DENY_REASON : startsHostApp(command) ? HOST_APP_REASON : null;
  if (!reason) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/**
 * `node scripts/release-suites.cjs --claude-hook` reads the tool call on stdin and prints the decision, if any.
 * @param {{ argv?: string[], read?: () => string, write?: (text: string) => void, env?: Env, inVm?: () => boolean }} [deps]
 */
function main({
  argv = process.argv.slice(2),
  read = () => readFileSync(0, 'utf8'),
  write = (t) => process.stdout.write(t),
  env = process.env,
  inVm = insideVirtualMachine,
} = {}) {
  if (argv[0] !== '--claude-hook') throw new Error('usage: node scripts/release-suites.cjs --claude-hook');
  const decision = claudeHookDecision(read(), env, inVm);
  if (decision) write(`${JSON.stringify(decision)}\n`);
  return decision;
}

module.exports = {
  insideVirtualMachine,
  releaseAllowed,
  requireRelease,
  runsInVirtualMachine,
  runsOnCiRunners,
  startsReleaseSuite,
  startsHostApp,
  claudeHookDecision,
  main,
};

if (require.main === module) main();
