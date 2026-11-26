// A chat on a machine keeps This Mac's composer labels (PR #5701): the owner's chat on a WSL laptop read "● LAPTOP-629FP…  Full acc…  Opus… H…" where a chat on This Mac read "Full access" and "Opus 4.7 High". In the real renderer, against the fake `ssh` Host, a started Claude Code chat on a machine with a long name is swept from 760px to 440px at 14px and 24px type in the narrowest window: no permission, model or effort label loses a letter while the machine's name still has room to give, and a name cut to a sliver is hidden.
// e2e-covers: src/components/composer/HostChip.tsx src/styles/app/composer-controls.css
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { connectSocket } from '../support/connectSocket';
import { test, expect } from './fixtures/app';
import { FAKE_SSH, FAKE_SSH_BIN } from './fixtures/fakeSsh';
import { withPath } from './fixtures/nodeCommand';
import { SYSTEM_THEME } from './fixtures/shoot';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-chip-fit-')));
fs.mkdirSync(path.join(ROOT, 'app', '.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hf-')));
const SOCK = path.join(RESIDENT, 'h.sock');

const NAME = 'WORKSTATION-7Q2LMXK';
const AGENTS = [
  {
    id: 'claude',
    detected: true,
    signedIn: true,
    models: [{ id: 'opus', name: 'Opus 4.7', default: true, efforts: ['low', 'high'], defaultEffort: 'high' }],
  },
];
const MACHINE = {
  id: 'ssh:me@box',
  name: NAME,
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: AGENTS,
  // read when the registry file is written, not when the worker loads this file (#3548)
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
test.setTimeout(240_000);

/** The Run on chip's machine and its folder, then Claude Code's model there. */
async function startOnMachine(page: Page) {
  await expect(page.locator('button.host-ctx')).toHaveAttribute('aria-label', 'Run on: This Mac, online', { timeout: 45_000 });
  await page.locator('button.host-ctx').click();
  await page
    .getByRole('menu', { name: 'My machines' })
    .getByRole('menuitemradio')
    .filter({ has: page.locator('.menu-title', { hasText: NAME }) })
    .click();
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.locator('.host-picker-open', { hasText: 'app' }).click();
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveAttribute('aria-label', new RegExp(`· ${NAME}`), { timeout: 30_000 });
  await page.getByRole('button', { name: 'Select model', exact: true }).click();
  const title = page.getByRole('button', { name: 'Select harness and model', exact: true });
  if (await title.count()) await title.click();
  await page.locator('.hp-row', { hasText: 'Claude Code' }).hover();
  await page.getByRole('menuitemradio', { name: /^Opus 4\.7/ }).click();
  await page.keyboard.press('Escape');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('hello box');
  await expect(composer).toHaveText('hello box');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText('fake-host: hello box', { exact: true })).toBeVisible({ timeout: 45_000 });
}

type Row = {
  width: number;
  /** pixels of the machine's name its box cuts; its box's width; whether it is drawn (not display: none) and marked a sliver */
  nameCut: number;
  nameBox: number;
  nameShown: boolean;
  sliver: boolean;
  anchor: number;
  /** pixels each label's box cuts from its text: 0 is whole */
  perm: number;
  model: number;
  effort: number;
  fontSize: number;
};

/** The started chat's footer at each composer width, as the renderer lays it out once the name's observer has run. */
const sweep = (page: Page, widths: number[]) =>
  page.evaluate(async (widths) => {
    const wrap = document.querySelector<HTMLElement>('.composer-wrap:has(button.host-chip)')!;
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const cut = (el: Element | null) => {
      if (!el || getComputedStyle(el).display === 'none') return 0;
      const range = document.createRange();
      range.selectNodeContents(el);
      return Math.max(0, range.getBoundingClientRect().width - el.getBoundingClientRect().width);
    };
    const rows = [];
    for (const width of widths) {
      wrap.style.width = `${width}px`;
      await frame();
      const name = wrap.querySelector<HTMLElement>('.host-name')!;
      rows.push({
        width,
        nameCut: cut(name),
        nameBox: name.getBoundingClientRect().width,
        nameShown: getComputedStyle(name).display !== 'none',
        sliver: name.hasAttribute('data-sliver'),
        anchor: name.closest('.tooltip-anchor')!.getBoundingClientRect().width,
        perm: cut(wrap.querySelector('.composer-left .perm-btn > span')),
        model: cut(wrap.querySelector('.model-name')),
        effort: cut(wrap.querySelector('.model-effort')),
        fontSize: Number.parseFloat(getComputedStyle(name).fontSize),
      });
    }
    wrap.style.width = '';
    return rows;
  }, widths);

const WIDTHS = Array.from({ length: 33 }, (_, i) => 760 - i * 10);

for (const fontSize of [14, 24]) {
  test.describe(`at ${fontSize}px type`, () => {
    test.use({
      harnesses: 'claude',
      shellPath: [FAKE_SSH_BIN],
      env: {
        MOPILOT_HOST_DEV: '1',
        FAKE_HOST_ROOT: ROOT,
        FAKE_HOST_LOG: LOG,
        FAKE_HOST_CHATS_SOCK: SOCK,
        FAKE_HOST_HARNESSES: JSON.stringify(AGENTS),
        PATH: withPath([FAKE_SSH_BIN]),
      },
      seed: {
        uiState: { ...SYSTEM_THEME, prefs: { permission: 'full-access', fontSize, zoomLevel: 0 } },
        userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } },
      },
    });

    test("the machine's name gives way before Full access, the model or the effort loses a letter", async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      await startOnMachine(page);
      const chip = page.locator('.composer-left button.host-chip');
      await expect(chip.locator('.host-name')).toHaveText(NAME);
      await expect(page.getByRole('button', { name: 'Change permissions' })).toContainText('Full access');

      const rows = await sweep(page, WIDTHS);
      console.log(`FOOTER_FIT ${fontSize}px ${JSON.stringify(rows)}`);
      await testInfo.attach(`footer-fit-${fontSize}.json`, { body: JSON.stringify(rows, null, 2), contentType: 'application/json' });
      const labelsCut = (r: Row) => r.perm > 0.01 || r.model > 0.01 || r.effort > 0.01;
      // folded: the chip is its dot and laptop (44px, or the 28px square of a narrow composer) or draws no name at all
      const folded = (r: Row) => !r.nameShown || r.nameBox < 1 || r.anchor <= 44.5;
      expect(
        rows.filter((r) => labelsCut(r) && !folded(r)),
        'a label lost a letter while the name still had room',
      ).toEqual([]);
      // the reported state: the name is cut and has room left, and every other label is whole
      expect(rows.some((r) => r.nameShown && r.nameCut > 0.01 && r.nameBox >= 1 && !labelsCut(r))).toBe(true);
      // wide enough, every label reads whole (the name itself is capped at 140px, so a large type may still cut it)
      expect(rows[0]).toMatchObject({ perm: 0, model: 0, effort: 0 });
      // no stray letter or bare "…" is drawn
      expect(
        rows.filter((r) => r.nameShown && r.nameCut > 0.01 && r.nameBox > 0 && r.nameBox < 2.5 * r.fontSize && !r.sliver),
        'a sliver of the name was drawn',
      ).toEqual([]);

      // pictures for the record: the widest width that cuts the name, and the first that folds it
      const wrap = page.locator('.composer-wrap:has(button.host-chip)');
      const shots = [rows.find((r) => r.nameCut > 0.01 && r.nameBox >= 1), rows.find((r) => r.nameShown && folded(r))];
      for (const row of shots.filter((r): r is Row => !!r)) {
        await wrap.evaluate((el, w) => {
          (el as HTMLElement).style.width = `${w}px`;
        }, row.width);
        await page.waitForTimeout(100);
        await wrap.screenshot({ path: testInfo.outputPath(`footer-${fontSize}px-${row.width}.png`) });
      }
    });
  });
}
