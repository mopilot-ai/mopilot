// The per-harness state `status` reports: whether each harness is installed on this Host and whether it is signed in, as { id, detected, signedIn }. Claude Code and Codex are asked of their own CLIs (the login on this machine); an ACP harness is signed in when this Host saw it complete a sign-in or a turn, or when it asks for no sign-in at all (./noSignIn.mjs).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { acpKeyed } from '../../shared/host/credentials.mjs';

const require = createRequire(import.meta.url);
const { parseClaudeStatus } = require('../../electron/harness/claude/status.cjs');

/** How long a vendor CLI may take to say whether it is signed in. */
const PROBE_MS = 5000;

/** How long an agent may read "checking" with no answer ever: past it the Host says it could not tell (`unsure`), so the person can still use the agent and the send reports the real cause. */
export const UNSURE_MS = 15_000;

/** Whether a CLI never answered: it was killed (the timeout), or could not start. A CLI that ran and exited non-zero did answer. @param {any} error */
const unanswered = (error) => !!error && (error.killed === true || Boolean(error.signal) || typeof error.code === 'string');

/** How long past its own timeout a CLI that will not die may keep a probe waiting: `execFile` calls back only when the CLI's pipes close, so a wrapper whose child holds them open never answers. */
const GRACE_MS = 1000;

/** The CLI run to a result: whether it exited 0, whether it never answered, and what it printed. Bounded by this Host's own timer too, so a CLI that ignores its kill cannot hold `status` (and the machine's heartbeat) for ever. @param {string} bin @param {string[]} args @param {NodeJS.ProcessEnv} env @param {typeof execFile} exec */
const run = (bin, args, env, exec) =>
  new Promise((resolve) => {
    /** @type {any} */
    let child;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve({ ok: false, unknown: true, stdout: '' });
    }, PROBE_MS + GRACE_MS);
    child = exec(bin, args, { env, timeout: PROBE_MS }, (error, stdout) => {
      clearTimeout(timer);
      resolve({ ok: !error, unknown: unanswered(error), stdout: String(stdout ?? '') });
    });
  });

/**
 * Whether Claude Code or Codex is signed in on this machine right now, asked of its own CLI: true, false, or null when the CLI could not say
 * (it timed out under load, could not start, or printed what is not a status). Null is never "signed out": a caller that cannot tell says so.
 * A CLI that is not installed is false.
 * @param {'claude' | 'codex'} id
 * @param {{ env: NodeJS.ProcessEnv, which: (name: string, env: NodeJS.ProcessEnv) => string | null, exec?: typeof execFile }} o
 * @returns {Promise<boolean | null>}
 */
export async function probeHarness(id, { env, which, exec = execFile }) {
  const bin = which(id, env);
  if (!bin) return false;
  if (id === 'claude') return claudeLoggedIn((await run(bin, ['auth', 'status'], env, exec)).stdout);
  const answer = /** @type {{ ok: boolean, unknown: boolean }} */ (await run(bin, ['login', 'status'], env, exec));
  return answer.unknown ? null : answer.ok;
}

/**
 * Why Claude Code reads as signed out on a Mac where it may well have signed in: its login lives in the login keychain, which a Host started
 * outside the person's desktop session (no one logged in on the screen, or started over SSH) cannot unlock. Asked of `security` itself, which
 * reads the keychain's settings and nothing in it. Null when the keychain answers, or on another system.
 * @param {{ env: NodeJS.ProcessEnv, exec?: typeof execFile, platform?: NodeJS.Platform }} o
 * @returns {Promise<'keychain-locked' | null>}
 */
export async function claudeSignedOutReason({ env, exec = execFile, platform = process.platform }) {
  if (platform !== 'darwin') return null;
  const answer = await new Promise((resolve) =>
    exec('/usr/bin/security', ['show-keychain-info'], { env, timeout: PROBE_MS }, (error, _stdout, stderr) =>
      resolve(error ? String(stderr ?? '') : ''),
    ),
  );
  return /User interaction is not allowed|could not be found|locked/i.test(/** @type {string} */ (answer)) ? 'keychain-locked' : null;
}

/**
 * @param {{ env: NodeJS.ProcessEnv, which: (name: string, env: NodeJS.ProcessEnv) => string | null, acp: { id: string, bin: string | null, signedIn: boolean }[], noSignIn?: { check: (id: string, bin: string) => Promise<boolean>, inspect?: (id: string, bin: string) => Promise<{ ready: boolean, methods: string[], checking?: true }> }, exec?: typeof execFile, platform?: NodeJS.Platform , last?: { get: (id: string) => boolean | undefined, set: (id: string, signedIn: boolean) => unknown, since: (id: string) => number, clear: (id: string) => unknown }, now?: () => number }} o
 * @returns {Promise<{ id: string, detected: boolean, signedIn: boolean, reason?: 'keychain-locked', signIn?: string[], checking?: true, unsure?: true }[]>}
 * reason: why an installed harness reads as signed out, when this Host can tell (only Claude Code's locked keychain today)
 * unsure: no probe has ever answered and the wait is over (UNSURE_MS); the Host keeps asking
 * signIn: the login methods an installed ACP agent lists when it cannot run without one
 */
export async function listHarnesses({ env, which, acp, noSignIn, exec = execFile, platform = process.platform, last, now = Date.now }) {
  const claude = which('claude', env);
  const codex = which('codex', env);
  const [claudeIn, codexIn, acpIn] = await Promise.all([
    probeHarness('claude', { env, which, exec }),
    probeHarness('codex', { env, which, exec }),
    Promise.all(
      acp.map(async (h) => {
        if (!h.bin) return { ready: false, methods: /** @type {string[]} */ ([]), checking: /** @type {true | undefined} */ (undefined) };
        if (h.signedIn) return { ready: true, methods: [] };
        if (!noSignIn) return { ready: false, methods: [] };
        // an agent that runs with no sign-in is ready; one that does not says which logins it lists
        if (noSignIn.inspect) return noSignIn.inspect(h.id, h.bin);
        return { ready: Boolean(await noSignIn.check(h.id, h.bin)), methods: [] };
      }),
    ),
  ]);
  // a probe that could not tell keeps the last answer it had; with none, the agent is still being checked, not signed out, until the wait is over
  const settled = (/** @type {string} */ id, /** @type {boolean | null} */ answer) => {
    if (answer !== null) return last?.set(id, answer), last?.clear(id), { signedIn: answer };
    const was = last?.get(id);
    if (was !== undefined) return { signedIn: was };
    const waited = last ? now() - last.since(id) : 0;
    return waited >= UNSURE_MS
      ? { signedIn: false, unsure: /** @type {true} */ (true) }
      : { signedIn: false, checking: /** @type {true} */ (true) };
  };
  const claudeState = settled('claude', claudeIn);
  const codexState = settled('codex', codexIn);
  const why = claude && claudeIn === false ? await claudeSignedOutReason({ env, exec, platform }) : null;
  return [
    { id: 'claude', detected: Boolean(claude), ...claudeState, ...(why ? { reason: why } : {}) },
    { id: 'codex', detected: Boolean(codex), ...codexState },
    ...acp.map((h, i) => ({
      id: h.id,
      detected: Boolean(h.bin),
      signedIn: acpIn[i].ready,
      ...(!acpIn[i].ready && acpIn[i].methods.length ? { signIn: acpIn[i].methods.slice(0, 4) } : {}),
      ...(!acpIn[i].ready && acpIn[i].checking ? { checking: /** @type {true} */ (true) } : {}),
    })),
  ];
}

/** `claude auth status` prints JSON whether or not it is logged in; anything else is a failed read, never an inferred sign-out. @param {string} stdout @returns {boolean | null} */
function claudeLoggedIn(stdout) {
  try {
    return parseClaudeStatus(stdout).loggedIn;
  } catch {
    return null;
  }
}

/** What the credential bookkeeping calls an agent: Claude Code and Codex by their own ids, every other agent through ACP. @param {string} id */
export const credentialKeyOf = (id) => (id === 'claude' || id === 'codex' ? id : `acp:${id}`);

/**
 * A status without the models: tells the credential bookkeeping each agent's sign-in state, which a chat is kept on a credential only once it knows (after a Host restart it does not until one is asked for).
 * @param {{ stateOf: (harness: string, signedIn: boolean) => unknown }} credentials @param {() => Promise<{ id: string, signedIn: boolean }[]>} list
 */
export const signInProbe = (credentials, list) => async () => {
  for (const h of await list()) credentials.stateOf(credentialKeyOf(h.id), h.signedIn);
};

/** The longest account name or plan the status carries: a line in a row, not a document. */
const LOGIN_TEXT_MAX = 60;
/** @param {unknown} v */
const lineOf = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, LOGIN_TEXT_MAX) : undefined);

/**
 * Which login Claude Code holds on this machine, as the CLI's own record says (its `oauthAccount`, in `.claude.json` of its config folder): the account's name and plan,
 * so the app can show which login runs here. Only those two lines: never a token, an address or an id. Null when there is no record or it says neither.
 * @param {{ env: NodeJS.ProcessEnv, home?: string, readFile?: (file: string) => string }} o `home`: where the CLI looks when the env names no folder
 * @returns {{ name?: string, plan?: string } | null}
 */
export function claudeLoginRecord({ env, home = os.homedir(), readFile = (file) => fs.readFileSync(file, 'utf8') }) {
  const dir = env.CLAUDE_CONFIG_DIR || env.HOME || home;
  if (!dir) return null;
  try {
    const account = JSON.parse(readFile(path.join(dir, '.claude.json')))?.oauthAccount;
    if (!account || typeof account !== 'object') return null;
    const name = lineOf(account.displayName) ?? lineOf(account.fullName);
    const plan = lineOf(account.planDisplayName) ?? lineOf(account.organizationType);
    return name || plan ? { ...(name ? { name } : {}), ...(plan ? { plan } : {}) } : null;
  } catch {
    return null;
  }
}

/**
 * A harness as `status` reports it: a Codex or Claude Code that can run gets the models it offers, so the app can offer them for a chat here, and
 * Claude Code, Codex and the ACP agents that sign in with an env key say they take a key and an organization lease the app lends (`takesKey`, `takesOrg`); with a key lent they can run signed out here too (./credentialLease.mjs).
 * @template {{ id: string, detected: boolean, signedIn: boolean }} H
 * @param {H} h
 * @param {{ codex: { models: () => Promise<unknown[]> }, sessions: { modelsOf: (id: string) => unknown, loginsOf?: (id: string) => object[], loginRefusedOf?: (id: string) => boolean, settlingOf?: (id: string) => boolean }, leases: { has: (harness: string) => boolean }, env?: NodeJS.ProcessEnv, credentials?: { stateOf: (harness: string, signedIn: boolean) => { sources: { own: boolean, key: boolean, org: boolean }, using: 'own' | 'key' | 'org' } } | null }} o
 */
export async function reportedHarness(h, { codex, sessions, leases, credentials, env = process.env }) {
  const reported = await reportedModels(h, { codex, sessions, leases });
  // which credentials exist for the agent and the one a chat started now would use; an agent run through ACP has one sign-in
  const first = h.id === 'claude' || h.id === 'codex';
  // a turn found the login unusable (the provider refuses it for its organization, or it lapsed): not ready, and the status says why before the next send
  const refused = h.id === 'claude' && h.signedIn && sessions.loginRefusedOf?.('claude') === true;
  // Claude Code lists the logins it keeps; Codex and the ACP agents have one sign-in until each gets its own home (H3)
  const logins = h.id === 'claude' ? sessions.loginsOf?.('claude') : [];
  // what asking for the models and the logins just started is not answered yet: the row says it is still being checked (the app asks again soon, electron/host/registry.cjs) and lists no login, rather than a default "signed out" the read has not yet confirmed (#5243)
  const settling = h.id === 'claude' && h.detected && sessions.settlingOf?.('claude') === true;
  // which login that is, as the CLI records it, so the app can say it before a message is sent
  const loginAccount = h.id === 'claude' && h.detected ? claudeLoginRecord({ env }) : null;
  return {
    ...reported,
    ...(loginAccount ? { loginAccount } : {}),
    ...(refused ? { signedIn: false, reason: /** @type {const} */ ('login-refused') } : {}),
    ...(settling ? { checking: /** @type {const} */ (true) } : {}),
    ...(logins?.length && !settling ? { logins, loginsSupported: true } : {}),
    ...credentials?.stateOf(credentialKeyOf(h.id), h.signedIn && !refused),
    ...(credentials && !first ? { loginsSupported: false } : {}),
  };
}

/** @template {{ id: string, detected: boolean, signedIn: boolean }} H @param {H} h @param {{ codex: { models: () => Promise<unknown[]> }, sessions: { modelsOf: (id: string) => unknown }, leases: { has: (harness: string) => boolean } }} o */
async function reportedModels(h, { codex, sessions, leases }) {
  if (h.id === 'codex')
    return {
      ...h,
      takesKey: true,
      takesOrg: true,
      // `chat.permit` takes `plan` for this agent (host/src/codexFamily.mjs): a client may offer Plan on a chat that runs here
      planMode: true,
      ...(h.detected && (h.signedIn || leases.has('codex')) ? { models: await codex.models() } : {}),
    };
  // an ACP agent that runs on a key in its env (Gemini, Grok, dsh) takes the user's key too
  if (h.id !== 'claude')
    return {
      ...h,
      ...(acpKeyed(h.id) ? { takesKey: true } : {}),
      ...(h.detected && (h.signedIn || leases.has(h.id)) ? { models: sessions.modelsOf(h.id) } : {}),
    };
  return {
    ...h,
    takesKey: true,
    takesOrg: true,
    // `chat.permit` takes `plan` for this agent too (host/src/claudeFamily.mjs): a client may offer Plan on a chat that runs here
    planMode: true,
    ...(h.detected && (h.signedIn || leases.has('claude')) ? { models: sessions.modelsOf('claude') } : {}),
  };
}
