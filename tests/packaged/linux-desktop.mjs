// Exercises an installed Linux package, its real keyring, native terminal and Rust sage-mcp tool bridge against isolated fake agents; CI/VM only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium, expect } from '@playwright/test';
import { registryAgent } from '../../shared/acpRegistry.mjs';
import { installerStopFixture } from './installer-stop.mjs';
import { collectNpmLogs } from './diagnostics.mjs';
import { pickHarness } from './harness-picker.mjs';
import { devToolsPort } from '../e2e/fixtures/chromeProfile.ts';

const { requireRelease } = createRequire(import.meta.url)('../../scripts/release-suites.cjs');
requireRelease('The packaged Linux journey', 'starts the installed app with scratch user data');
assert.equal(process.platform, 'linux', 'Run this check on an isolated Linux CI runner.');
const executable = path.resolve(process.argv[2] ?? '');
assert.equal(path.basename(executable), 'mopilot', 'Pass the installed mopilot executable.');
assert.ok(fs.existsSync(executable));
const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-linux-journey-'));
const userData = path.join(scratch, 'user-data');
const output = path.resolve(process.env.MOPILOT_LINUX_CHECK_OUTPUT || 'test-results/linux-package');
fs.mkdirSync(output, { recursive: true });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const write = (file, content, mode = 0o600) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
};
const wrapper = (name, source) => {
  const file = path.join(scratch, name);
  write(file, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, source))} "$@"\n`, 0o700);
  return file;
};
const codex = wrapper('codex', 'tests/e2e/fixtures/fake-codex.mjs');
const claude = wrapper('claude', 'tests/e2e/fixtures/fake-claude.mjs');
const loginShell = path.join(scratch, 'login-shell');
write(loginShell, '#!/bin/sh\nfor a; do c=$a; done\nexec /bin/sh -c "$c"\n', 0o700);
write(
  path.join(scratch, 'shadow-bin/linux-check'),
  `#!/bin/sh\nprintf wrong-installation > ${quote(path.join(scratch, 'wrong-login'))}\nexit 1\n`,
  0o700,
);
for (const dir of ['home', 'codex-home', 'claude-home', 'config']) fs.mkdirSync(path.join(scratch, dir));
const packageDir = path.join(scratch, 'package');
write(
  path.join(packageDir, 'package.json'),
  JSON.stringify({ name: '@mopilot-linux-check/agent', version: '1.0.0', bin: { 'linux-check-agent': 'agent' } }),
);
write(
  path.join(packageDir, 'agent'),
  `#!/bin/sh\nif [ "$1" = '--login' ]; then printf managed > ${quote(path.join(scratch, 'managed-terminal-login'))}; fi\nexec ${quote(process.execPath)} ${quote(path.join(root, 'tests/fixtures/fake-acp-agent.mjs'))} "$@"\n`,
  0o755,
);
const verifyInstallerStop = installerStopFixture({ scratch, packageDir, write });
const packageManifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
const archive = path.join(scratch, 'agent.tgz');
execFileSync('tar', ['-czf', archive, '-C', scratch, 'package']);
const bytes = fs.readFileSync(archive);
let siteVisits = 0;
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (pathname === '/agent.tgz') {
    response.end(bytes);
    return;
  }
  if (pathname.startsWith('/site')) {
    siteVisits++;
    response.setHeader('content-type', 'text/html');
    response.end('<h1>Linux package browser fixture</h1>');
    return;
  }
  if (request.method === 'POST') {
    response.setHeader('content-type', 'application/json');
    response.end('{}');
    return;
  }
  const name = '@mopilot-linux-check/agent';
  const version = {
    ...packageManifest,
    hasInstallScript: true,
    dist: {
      tarball: `${origin}/agent.tgz`,
      shasum: createHash('sha1').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    },
  };
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': version } }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const entry = registryAgent({
  id: 'linux-check',
  name: 'Linux Check',
  version: '1.0.0',
  website: 'https://example.test',
  distribution: {
    npx: {
      package: '@mopilot-linux-check/agent@1.0.0',
      args: ['--acp'],
      env: {
        FAKE_ACP_LOG: path.join(scratch, 'acp.jsonl'),
        FAKE_ACP_STATE: path.join(scratch, 'acp-state'),
        FAKE_ACP_PROFILE: JSON.stringify({
          needsAuth: true,
          resume: true,
          authMethods: [
            { id: 'fixture', name: 'Sign in to fixture' },
            {
              id: 'terminal',
              name: 'Sign in to managed fixture',
              _meta: { 'terminal-auth': { command: 'linux-check', args: ['--login', path.join(scratch, 'acp-state')] } },
            },
          ],
        }),
      },
    },
  },
});
write(path.join(userData, 'registry-agents/catalog.json'), JSON.stringify({ checkedAt: Date.now(), agents: [entry] }));
write(
  path.join(userData, 'ui-state.json'),
  JSON.stringify({ codexBin: codex, prefs: { confirmClose: 'never', shareUsageData: false, autoUpdate: false, importSync: false } }),
);
write(path.join(scratch, 'npmrc'), '');
const desktopEnv = Object.fromEntries(
  [
    'PATH',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'XDG_CURRENT_DESKTOP',
    'DESKTOP_SESSION',
    'GNOME_KEYRING_CONTROL',
    'GNOME_KEYRING_PID',
    'LD_LIBRARY_PATH',
  ]
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
const env = {
  ...desktopEnv,
  PATH: `${path.join(scratch, 'shadow-bin')}${path.delimiter}${desktopEnv.PATH}`,
  HOME: path.join(scratch, 'home'),
  SHELL: loginShell,
  XDG_CONFIG_HOME: path.join(scratch, 'config'),
  MOPILOT_USER_DATA: userData,
  CODEX_HOME: path.join(scratch, 'codex-home'),
  CLAUDE_CONFIG_DIR: path.join(scratch, 'claude-home'),
  CODEX_BIN: codex,
  CLAUDE_BIN: claude,
  FAKE_CODEX_LOG: path.join(scratch, 'codex.jsonl'),
  FAKE_CODEX_PROJECTS: '[]',
  FAKE_CLAUDE_LOG: path.join(scratch, 'claude.jsonl'),
  FAKE_CLAUDE_AUTH: 'subscription',
  SAGE_NO_RELAY: '1',
  SAGE_ACP_BINS: '{}',
  SAGE_DEBUG_TOOLS: '1',
  SAGE_E2E_BACKGROUND: '1',
  MOPILOT_API: 'http://127.0.0.1:9',
  npm_config_registry: origin,
  npm_config_cache: path.join(scratch, 'npm-cache'),
  npm_config_userconfig: path.join(scratch, 'npmrc'),
};
let child;
let browser;
let page;
const steps = [];
const step = (message) => {
  steps.push(message);
  console.log(`PASS: ${message}`);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const launch = async () => {
  const activePort = path.join(userData, 'DevToolsActivePort');
  fs.rmSync(activePort, { force: true });
  child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream(path.join(output, 'app.log'), { flags: 'a' });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once('close', () => log.end());
  let launchError;
  child.once('error', (error) => {
    launchError = error;
  });
  const deadline = Date.now() + 90_000;
  let port = null;
  while ((port = devToolsPort(fs.existsSync(activePort) ? fs.readFileSync(activePort, 'utf8') : null)) === null) {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null, 'Packaged app exited before its debugging port opened. See app.log.');
    assert.ok(Date.now() < deadline, 'Packaged app did not open its debugging port. See app.log.');
    await pause(200);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await expect
    .poll(
      () =>
        browser
          .contexts()[0]
          .pages()
          .find((candidate) => candidate.url().startsWith('file:') && !candidate.url().includes('#mini')),
      { timeout: 60_000 },
    )
    .toBeTruthy();
  page = browser
    .contexts()[0]
    .pages()
    .find((candidate) => candidate.url().startsWith('file:') && !candidate.url().includes('#mini'));
  page.setDefaultTimeout(30_000);
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible({ timeout: 60_000 });
};
const quit = async () => {
  if (!child || child.exitCode !== null) return;
  const ended = once(child, 'exit');
  if (page && !page.isClosed()) await page.keyboard.press('Control+q').catch(() => undefined);
  const timer = setTimeout(() => child.kill('SIGTERM'), 10_000);
  const kill = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    await ended;
  } finally {
    clearTimeout(timer);
    clearTimeout(kill);
  }
  await browser?.close();
};
const logOf = (file) => readJsonLineLog(path.join(scratch, file));
const send = async (text) => {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
};
const idle = () => expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
const main = () => page.getByRole('main');
const newChat = async () => {
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
};
try {
  await launch();
  assert.equal(await page.evaluate(() => window.native.platform), 'linux');
  step('installed .deb starts with production fuses and Chromium sandbox');
  await page.locator('.sidebar-title').first().click();
  await page.getByRole('menuitem', { name: /^Settings\b/ }).click();
  const search = page.getByRole('textbox', { name: 'Search settings', exact: true });
  await search.fill('Other agents');
  await page
    .locator('.settings-nav .side-row:not(.has-hint)')
    .filter({ has: page.getByText('Other agents', { exact: true }) })
    .click();
  await search.fill('');
  await page.getByRole('button', { name: 'Browse agent directory' }).click();
  await verifyInstallerStop(page, userData, output);
  step('registry install Stop retains staging and ownership until real TERM-resistant descendants disappear; retry is enabled');
  await page.locator('[data-registry-agent="linux-check"]').getByRole('button', { name: 'Install', exact: true }).click();
  await expect
    .poll(() => page.evaluate(async () => (await window.native.acp.harnesses()).find((row) => row.id === 'registry-linux-check')?.state), {
      timeout: 90_000,
    })
    .toBe('signin');
  await page.evaluate(() => window.native.acp.authenticate('registry-linux-check', 'fixture'));
  await expect(page.locator('[data-harness="registry-linux-check"] .basic-row-state')).toHaveText('Ready', { timeout: 60_000 });
  fs.rmSync(path.join(scratch, 'acp-state/authed'));
  await page.evaluate(() => window.native.acp.recheck('registry-linux-check'));
  const managedRow = page.locator('[data-harness="registry-linux-check"]');
  await expect(managedRow.locator('.basic-row-state')).toHaveText('Not signed in');
  await managedRow.getByRole('button', { name: 'Sign in to managed fixture', exact: true }).click();
  await expect(managedRow.locator('.basic-row-state')).toHaveText('Ready', { timeout: 60_000 });
  assert.equal(fs.existsSync(path.join(scratch, 'wrong-login')), false, 'Terminal login must not run the shadow CLI on PATH.');
  assert.equal(fs.existsSync(path.join(scratch, 'acp-state/authed')), true);
  assert.equal(
    fs.readFileSync(path.join(scratch, 'managed-terminal-login'), 'utf8'),
    'managed',
    'The managed terminal must actually execute.',
  );
  step('registry UI installs a pinned package; ACP and managed terminal sign-in avoid the shadow CLI and pass real sage-mcp admission');
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  await pickHarness(page, 'Linux Check');
  await send('hello linux package');
  await expect(main()).toContainText('fake-acp: hello linux package');
  await idle();
  await send('MCPCALL linux_package_bridge');
  await expect(main()).toContainText('echo: linux_package_bridge');
  await idle();
  await send('PERMIT package action');
  await expect(page.locator('.approval-card')).toContainText('Fake action');
  const permission = logOf('acp.jsonl').findLast((row) => row.kind === 'out' && row.msg?.method === 'session/request_permission').msg;
  await page.keyboard.press('1');
  await idle();
  assert.deepEqual(logOf('acp.jsonl').findLast((row) => row.kind === 'in' && row.msg?.id === permission.id)?.msg.result.outcome, {
    outcome: 'selected',
    optionId: 'allow',
  });
  const beforeStop = logOf('acp.jsonl').length;
  await send('SLOW package cancellation');
  await expect(main()).toContainText('fake-acp: SLOW package cancellation');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await idle();
  const stopped = logOf('acp.jsonl').slice(beforeStop);
  const slowSession = stopped.find(
    (row) =>
      row.kind === 'in' && row.msg?.method === 'session/prompt' && JSON.stringify(row.msg.params).includes('SLOW package cancellation'),
  ).msg.params.sessionId;
  assert.ok(stopped.some((row) => row.kind === 'in' && row.msg?.method === 'session/cancel' && row.msg.params.sessionId === slowSession));
  step('registry chat sends, streams, calls the packaged Rust sage-mcp bridge, approves and stops');
  await newChat();
  await pickHarness(page, 'Codex', 'Fake Model One');
  await send('CUCALL run_in_terminal {"command":"echo LINUX_PACKAGE_$((20+22))"}');
  await expect(page.locator('.sage-approval')).toHaveAttribute('data-kind', 'terminalTab');
  await page
    .locator('.sage-approval')
    .getByRole('button', { name: /^Allow once/ })
    .click();
  await idle();
  await send('CUCALL read_terminal {"wait_for_output_ms":4000}');
  await expect(main()).toContainText('LINUX_PACKAGE_42');
  await idle();
  await send(`CUCALL browser_navigate ${JSON.stringify({ url: `${origin}/site` })}\nCUCALL browser_get_page_text {}`);
  await expect(page.locator('.sage-approval')).toBeVisible();
  await page
    .locator('.sage-approval')
    .getByRole('button', { name: /Allow in this chat/ })
    .click();
  await expect(main()).toContainText('Linux package browser fixture');
  await idle();
  assert.ok(siteVisits > 0);
  step('native Linux terminal executes and the built-in browser navigates an approved local site');
  await newChat();
  await pickHarness(page, 'Claude Code', 'Fake Sonnet');
  await send('hello linux claude');
  await expect(main()).toContainText('fake-claude: hello linux claude');
  await idle();
  const secret = 'sk-linux-package-fixture-only';
  const accounts = await page.evaluate(({ secret, origin }) => window.native.accounts.addApiKey(secret, origin), { secret, origin });
  const keyAccount = accounts.accounts.find((account) => account.kind === 'apiKey' && !account.isDefault);
  assert.ok(keyAccount, 'The fixture API key must be saved as a managed account.');
  const accountIds = accounts.accounts.map((account) => account.id).sort();
  const sealed = fs.readdirSync(userData, { recursive: true }).filter((file) => /accounts\/.*auth\.json\.enc$/.test(file));
  assert.ok(sealed.length > 0, 'The keyring must encrypt at least one managed account.');
  for (const file of [...sealed, 'accounts.json'])
    assert.equal(
      fs.readFileSync(path.join(userData, file)).includes(Buffer.from(secret)),
      false,
      'Saved account files must not contain the API key.',
    );
  await page.screenshot({ path: path.join(output, 'linux-chat.png') });
  const previousSession = logOf('acp.jsonl').find(
    (row) => row.kind === 'in' && row.msg?.method === 'session/prompt' && JSON.stringify(row.msg.params).includes('hello linux package'),
  ).msg.params.sessionId;
  await quit();
  const codexBeforeRestart = logOf('codex.jsonl').length;
  const acpBeforeRestart = logOf('acp.jsonl').length;
  await launch();
  const restoredAccounts = await page.evaluate(() => window.native.accounts.apply());
  assert.deepEqual(restoredAccounts.accounts.map((account) => account.id).sort(), accountIds);
  assert.equal(restoredAccounts.accounts.find((account) => account.id === keyAccount.id)?.status, 'ok');
  assert.ok(
    logOf('codex.jsonl')
      .slice(codexBeforeRestart)
      .some((row) => row.method === 'account/login/start' && row.params?.type === 'apiKey' && row.params.apiKey === secret),
    'A fresh app-server must receive the decrypted fixture key after restart.',
  );
  await page.getByRole('complementary').locator('[data-sidebar-chat^="acp:registry-linux-check:"]').first().click();
  await expect(main()).toContainText('fake-acp: hello linux package');
  await send('HISTORY after restart');
  await expect(main()).toContainText('fake-acp: HISTORY after restart [history: 3]');
  await idle();
  assert.ok(
    logOf('acp.jsonl')
      .slice(acpBeforeRestart)
      .some(
        (row) =>
          row.kind === 'in' && ['session/resume', 'session/load'].includes(row.msg?.method) && row.msg.params.sessionId === previousSession,
      ),
  );
  step('Codex, Claude Code and registry chats coexist; encrypted account records and ACP history survive restart');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, arch: process.arch, steps }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
    await page
      .evaluate(() => document.body.innerText)
      .then((text) => write(path.join(output, 'failure.txt'), text))
      .catch(() => undefined);
    await page
      .evaluate(async () => {
        const runs = await window.native.harnessRuns.list();
        return Promise.all(runs.map(async (run) => ({ ...run, output: await window.native.harnessRuns.attach(run.id) })));
      })
      .then((runs) => write(path.join(output, 'harness-runs.json'), JSON.stringify(runs, null, 2)))
      .catch(() => undefined);
  }
  collectNpmLogs({ scratch, userData, output });
  for (const name of ['codex.jsonl', 'claude.jsonl', 'acp.jsonl'])
    if (fs.existsSync(path.join(scratch, name))) fs.copyFileSync(path.join(scratch, name), path.join(output, name));
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: false, arch: process.arch, steps, error: error.stack }, null, 2));
  throw error;
} finally {
  await quit();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
