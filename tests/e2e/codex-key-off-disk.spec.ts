// #2201: an added Codex API key never lands in the CLI's own ~/.codex/auth.json. The app stores it for its thread
// provider (the real auth-command helper, built here, keeps it in the keychain) instead of logging the app-server in
// with it, and every thread names that provider: the first turn's thread/start, the thread/resume after a relaunch,
// and a fork. The helper itself answers with the key.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the API key helper Codex runs (native/auth-command) builds only on macOS');

const KEY = 'sk-fake-off-disk-4242';
const CLI_OWN = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fake-cli-own-1111' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText(`fake-codex: ${text}`, { exact: true })).toBeVisible();
}
const HELPER = path.resolve('native/auth-command/build/auth-command');
/** Whether the helper can keep a key in this machine's keychain at all: set, get and delete a probe item. */
function keychainWorks(env: NodeJS.ProcessEnv) {
  // a keychain that is missing or locked can put up a prompt: never wait for it
  const run = (verb: string, input?: string) =>
    execFileSync(HELPER, [verb, 'ai.mopilot.code.e2e-probe', 'probe'], {
      env,
      input,
      timeout: 10_000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  try {
    run('set', 'probe-value');
    const ok = run('get').trim() === 'probe-value';
    run('delete');
    return ok ? 'ok' : 'read back something else';
  } catch (error) {
    return String((error as any).stderr || (error as Error).message).trim();
  }
}
/**
 * The app runs with a scratch HOME, which has no login keychain: the helper would find none (and macOS may prompt).
 * On a CI runner, give that home an unlocked keychain of its own as its default. Never on a person's Mac, where the
 * keychain search list is theirs: the spec skips there.
 */
function scratchKeychain(home: string) {
  const file = path.join(home, 'Library', 'Keychains', 'login.keychain-db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const env = { ...process.env, HOME: home };
  const security = (...args: string[]) => execFileSync('/usr/bin/security', args, { env, timeout: 10_000, stdio: 'pipe' });
  security('create-keychain', '-p', 'mopilot-e2e', file);
  security('unlock-keychain', '-p', 'mopilot-e2e', file);
  security('set-keychain-settings', file);
  security('default-keychain', '-d', 'user', '-s', file);
}
const logins = (h: Harness) => h.codexLog().filter((e) => e.method === 'account/login/start' && e.params?.type === 'apiKey');
/** The provider a thread request named, with the command and arguments auth-command runs. */
function providerOf(params: any) {
  const def = params?.config?.model_providers?.[params?.modelProvider];
  return def ? { id: params.modelProvider, base: def.base_url, command: def.auth.command, args: def.auth.args } : null;
}

test.describe('an added API key', () => {
  test.skip(!process.env.CI, 'needs a keychain the app’s scratch HOME can use; runs on CI runners only');
  test.beforeAll(() => {
    // the helper Codex runs as the provider's auth.command (a checkout does not have it until built; swift build)
    test.setTimeout(300_000);
    if (!fs.existsSync(HELPER)) execFileSync(process.execPath, ['scripts/build-auth-command.mjs'], { stdio: 'inherit' });
  });
  test.use({
    harnesses: 'codex',
    seed: {
      files: (d) => {
        scratchKeychain(d.home);
        // the CLI's own sign-in, which must stay exactly as it is
        fs.writeFileSync(path.join(d.codexHome, 'auth.json'), CLI_OWN);
        const home = path.join(d.userData, 'accounts', 'k');
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
        // plain as an earlier version left it; the vault seals it at start
        fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: KEY }));
        const account = { id: 'k', kind: 'apiKey', email: null, planType: null, baseUrl: null, status: 'ok', addedAt: 1 };
        fs.writeFileSync(path.join(d.userData, 'accounts.json'), JSON.stringify({ active: 'k', accounts: [account] }));
      },
    },
  });

  test('goes to every thread through its provider and never into the CLI’s auth.json', async ({ page, harness }) => {
    const cliAuth = path.join(harness.dir, 'home', '.codex', 'auth.json');
    const at = fs.statSync(cliAuth).mtimeMs;
    // without a usable keychain the app takes its fallback (a login), and this check can't run here
    expect(keychainWorks({ ...process.env, ...harness.env }), 'the helper keeps a key in the app’s keychain').toBe('ok');
    await send(page, 'first on the key');
    const start = harness.codexLog().find((e) => e.method === 'thread/start' && providerOf(e.params));
    // the thread's id comes back in thread/start's answer; its first turn names it
    const threadId = harness.codexLog().find((e) => e.method === 'turn/start' && e.params.input?.[0]?.text === 'first on the key')
      ?.params.threadId;
    expect(start, `thread/start names a provider; logins sent: ${JSON.stringify(logins(harness).map((e) => e.params.type))}`).toBeTruthy();
    if (!start) return;
    const provider = providerOf(start.params)!;
    expect(provider.base).toBe('https://api.openai.com/v1');
    expect(provider.command).toMatch(/auth-command$/);
    // the helper answers with the key, from the keychain
    expect(
      execFileSync(provider.command, provider.args, { env: { ...process.env, ...harness.env }, timeout: 10_000, encoding: 'utf8' }).trim(),
    ).toBe(KEY);

    await harness.quit();
    await harness.relaunch();
    const p = harness.page;
    await p.getByRole('complementary').getByText('Fake chat title', { exact: true }).click();
    await send(p, 'after the relaunch');
    const resume = harness.codexLog().find((e) => e.method === 'thread/resume' && e.params.threadId === threadId);
    if (providerOf(resume?.params)?.id !== provider.id) {
      // say why: every resume the app-server got, and what the app recorded about providers and keys
      const resumes = harness
        .codexLog()
        .filter((e) => e.method === 'thread/resume')
        .map((e) => [e.params.threadId, e.params.modelProvider ?? null]);
      const ignored = await harness.app.evaluate(
        (_e, file) =>
          (process as any).mainModule
            ?.require(file)
            .recentIgnored()
            .map((e: any) => `${e.context}: ${e.message}`),
        path.resolve('electron/ignored.cjs'),
      );
      throw new Error(
        `resume without the provider; start ${threadId}; resumes ${JSON.stringify(resumes)}; recorded ${JSON.stringify(ignored)}`,
      );
    }

    await transcript(p).getByRole('button', { name: 'Fork chat from here' }).first().click();
    await expect(p.getByText('Forked into a new chat')).toBeVisible();
    const fork = harness.codexLog().find((e) => e.method === 'thread/fork')!;
    expect(providerOf(fork.params)?.id).toBe(provider.id);

    expect(logins(harness), 'the app-server is never logged in with the key').toEqual([]);
    expect(fs.readFileSync(cliAuth, 'utf8')).toBe(CLI_OWN);
    expect(fs.statSync(cliAuth).mtimeMs, 'the CLI’s auth.json was never rewritten').toBe(at);
  });
});
