// The fake ACP agent's sign-ins (tests/fixtures/fake-acp-agent.mjs): the auth methods it lists, the terminal login
// they may point at, authenticate, and a browser sign-in that waits until the user finishes.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { waitForAcpLoginRelease } from './acp-login-gate.mjs';

/** `--login <state dir>`: the terminal login a harness's authMethods point at (terminalLogin); exits once signed in. */
export async function terminalLogin(argv) {
  if (argv[2] !== '--login') return;
  await waitForAcpLoginRelease(argv[3]);
  fs.mkdirSync(argv[3], { recursive: true });
  fs.writeFileSync(path.join(argv[3], 'authed'), '');
  process.stdout.write('Logged in.\n');
  process.exit(0);
}

/** initialize's authMethods: a terminal-auth method running this agent with --login (terminalLogin), or the profile's. */
export const authMethods = (profile, state) =>
  profile.terminalLogin
    ? [
        {
          id: 'terminal',
          name: 'Log in in terminal',
          _meta: { 'terminal-auth': { command: process.execPath, args: [process.argv[1], '--login', state], label: 'fake login' } },
        },
      ]
    : (profile.authMethods ?? []);

/** Whether session/new may go: needsAuth refuses it until $FAKE_ACP_STATE/authed exists. */
export const authed = (profile, state) => !profile.needsAuth || (state && fs.existsSync(path.join(state, 'authed')));

/**
 * authenticate: signs in ($FAKE_ACP_STATE/authed). With browserLogin it first waits like a browser sign-in, until
 * $FAKE_ACP_STATE/browser-ok exists (signed in) or browser-fail does (fails with its text as the agent's message).
 */
export async function authenticate(profile, state) {
  const at = (f) => path.join(state ?? '.', f);
  // a headless CLI prints its link and device code on stderr
  if (profile.browserLogin && !profile.splitLink) {
    const device = 'Open https://login.example.test/device and enter code ABCD-1234\n';
    const flood = Array.from({ length: 12 }, (_, i) => `https://login.example.test/n${i}`).join(' ');
    for (const line of ['Starting login\n', device, device, `${flood}\n`]) process.stderr?.write?.(line);
  }
  if (profile.splitLink) {
    // a link cut in two writes, and a full stop after it
    process.stderr?.write?.('Go to https://login.example.test/sp');
    await new Promise((r) => setTimeout(r, 40));
    process.stderr?.write?.('lit?x=1. Then enter code WXYZ-9876\nmore');
    await new Promise((r) => setTimeout(r, 40));
    process.stderr?.write?.(' text\n');
  }
  while (profile.browserLogin && !fs.existsSync(at('browser-ok'))) {
    if (fs.existsSync(at('browser-fail'))) throw new Error(fs.readFileSync(at('browser-fail'), 'utf8').trim());
    await new Promise((r) => setTimeout(r, 50));
  }
  if (state) {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'authed'), '');
  }
  return {};
}
