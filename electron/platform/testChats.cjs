// Where a test instance's chats go when it runs on the user's own home folder (#1724): one scratch folder per run, so test chats never land in ~/Documents/MoPilot or the user's projects.
//
// Agents check fixes in a background dev instance (SAGE_E2E_BACKGROUND=1) on the user's Mac with the user's real Codex
// and Claude Code logins, so every chat it starts is also a session in ~/.codex or ~/.claude, and its folder is a
// project in the user's own MoPilot. Such an instance makes a projectless chat's folder under
// <test root>/<run>/ instead of the projectless folder; scripts/test-chats.mjs gives a run its project folder there and
// archives the run's chats by it at the end. E2E runs (a scratch HOME) and the user's own instances are unaffected.
const os = require('node:os');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');

/** The scratch root of every test run's chats: /private/tmp on macOS (one folder for every user's runs), the temp folder elsewhere. */
const testChatsRoot = (platform = process.platform, tmp = os.tmpdir()) =>
  platform === 'darwin' ? '/private/tmp/mopilot-test' : path.join(tmp, 'mopilot-test');
const TEST_CHATS_ROOT = testChatsRoot();
/** A run tag: a single folder name. */
const RUN_TAG = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** The account's own home folder (not HOME), or null where the system can't say (no passwd entry). */
function accountHome() {
  try {
    return os.userInfo().homedir;
  } catch (error) {
    noteIgnored("read the account's home folder for a test instance", error);
    return null;
  }
}

/**
 * The folder this instance's test chats go in, or null when it is not a test instance on the user's own home.
 * @param {{ env?: Record<string, string | undefined>, home?: string, realHome?: () => string | null, pid?: number, root?: string }} [o]
 *   `env.MOPILOT_TEST_RUN`: the run's tag (else run-<pid>); `home`: HOME as this process sees it; `realHome`: the account's,
 *   read only for a test instance
 */
function testRunFolder({ env = process.env, home = os.homedir(), realHome = accountHome, pid = process.pid, root = TEST_CHATS_ROOT } = {}) {
  if (env.SAGE_E2E_BACKGROUND !== '1') return null;
  const account = realHome();
  if (!account || path.resolve(home) !== path.resolve(account)) return null;
  const tag = RUN_TAG.test(env.MOPILOT_TEST_RUN ?? '') ? String(env.MOPILOT_TEST_RUN) : `run-${pid}`;
  return path.join(root, tag);
}

module.exports = { testRunFolder, testChatsRoot, accountHome, TEST_CHATS_ROOT, RUN_TAG };
