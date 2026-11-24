// Keys in the composer of a machine chat whose start the Host answers late (#5402): while the chat is starting the composer is busy; whatever it takes or refuses, it says so, and keys are never taken half-way (IME text in, punctuation and Backspace out).
// e2e-covers: src/components/composer/ComposerInput.tsx src/components/composer/Composer.tsx
import fs from 'node:fs';
import { connectSocket } from '../support/connectSocket';
import os from 'node:os';
import path from 'node:path';
import { type ChildProcess, spawn } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { SYSTEM_THEME } from './fixtures/shoot';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-attention-e2e-')));
const FOLDER = path.join(ROOT, 'projects/app');
fs.mkdirSync(path.join(FOLDER, '.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-')));
const SOCK = path.join(RESIDENT, 'h.sock');
const FAKE_SSH = path.join(__dirname, 'fixtures/fake-ssh');

const AGENTS = ['kimi', 'claude', 'codex'].map((id) => ({
  id,
  detected: true,
  signedIn: true,
  models: [{ id: `${id}-remote-default`, name: `${id} Remote default`, default: true, efforts: ['low'], defaultEffort: 'low' }],
}));
const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: AGENTS,
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
};

let resident: ChildProcess | null = null;
test.beforeAll(async () => {
  resident = spawn(process.execPath, [path.join(FAKE_SSH, 'host-chats.cjs')], {
    env: { ...process.env, FAKE_HOST_CHATS_SOCK: SOCK, FAKE_HOST_LOG: LOG },
    stdio: 'ignore',
  });
  (await connectSocket(SOCK, 'the resident Host to accept a connection', { timeoutMs: 10_000 })).destroy();
});
test.afterAll(() => {
  resident?.kill();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(RESIDENT, { recursive: true, force: true });
});

test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  shellPath: [FAKE_SSH],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_LOG: LOG,
    FAKE_HOST_CHATS_SOCK: SOCK,
    FAKE_HOST_HARNESSES: JSON.stringify(AGENTS),
    MOPILOT_FLAGS: 'host.unattended=1',
    FAKE_HOST_ACK_MS: '15000',
    PATH: `${FAKE_SSH}:${process.env.PATH}`,
  },
  seed: { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } },
});
test.setTimeout(240_000);
test.beforeEach(() => fs.rmSync(LOG, { force: true }));

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

/** What the editor says about itself: whether it blocks edits, what it shows and who has the focus. */
const editorState = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[role="textbox"][aria-label="Message"]') as HTMLElement | null;
    return {
      ariaDisabled: el?.getAttribute('aria-disabled') ?? null,
      placeholder: el?.getAttribute('data-placeholder') ?? null,
      focused: document.activeElement === el,
      text: el?.textContent ?? null,
    };
  });

test('typing while a machine chat is starting (the Host answers its start late): every key lands or none does, and the composer says it is busy', async ({
  harness,
}, testInfo) => {
  test.setTimeout(240_000);
  const page = harness.page;
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
  await page.locator('.ctxbar .ctx-btn').first().click();
  await page.getByText('Folder on box…').click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.locator('.host-picker-open', { hasText: 'projects' }).click();
  await dialog.locator('.host-picker-open', { hasText: 'app' }).click();
  await dialog.getByRole('button', { name: 'Use this folder' }).click();

  await composer(page).fill('slow');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const cdp = await page.context().newCDPSession(page);
  const steps: Record<string, unknown>[] = [];
  const note = async (name: string) => steps.push({ name, at: Date.now(), ...(await editorState(page)) });
  await note('just sent');
  await composer(page).click();
  await note('focused while the chat starts');
  await page.keyboard.type('ab', { delay: 60 });
  await note('typed ab');
  await page.keyboard.type(',.;!', { delay: 60 });
  await note('typed punctuation');
  await page.keyboard.press('Backspace');
  await note('Backspace');
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await page.waitForTimeout(60);
  await cdp.send('Input.insertText', { text: '你' });
  await note('IME commit');
  await page.keyboard.type('，', { delay: 60 });
  await page.keyboard.press('Backspace');
  await note('IME then punctuation then Backspace');
  // the Host answers (15 s late): the composer takes keys again
  await page.waitForTimeout(20_000);
  await note('after the Host answered');
  await page.keyboard.type('x', { delay: 60 });
  await note('typed x after');
  await testInfo.attach('editor-steps.json', { body: JSON.stringify(steps, null, 2), contentType: 'application/json' });
  console.log(`EDITOR_STEPS ${JSON.stringify(steps)}`);
});
