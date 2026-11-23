// A sent picture: a double-click opens its preview and leaves it open; a right-click offers Copy Image, Save Image As… and Show in Finder/Folder (#4445).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const REVEAL = process.platform === 'darwin' ? 'Show in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Show in Folder';
const IMAGE_MENU = ['Copy Image', 'Save Image As…', 'separator', REVEAL];

test.use({ harnesses: 'codex' });

test('a sent picture opens on double-click and its right-click menu copies, saves and reveals it', async ({ page, harness }, testInfo) => {
  await expect(composer(page)).toBeVisible();
  // a 240x160 picture pasted into the composer, as the clipboard hands it over; its bytes come back for the save check
  const b64 = await composer(page).evaluate(async (el) => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 160;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#f5b66b';
    g.fillRect(0, 0, 240, 160);
    g.fillStyle = '#1d4ed8';
    g.fillRect(40, 40, 160, 80);
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return btoa(String.fromCharCode(...bytes));
  });
  const PNG = Buffer.from(b64, 'base64');
  await expect(page.locator('.attachment img')).toHaveCount(1);
  await composer(page).fill('what is this picture');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const sent = page.getByRole('main').locator('.user-message .user-images img');
  await expect(sent).toHaveCount(1);
  await expect.poll(() => sent.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);

  // the bug: the second press of the double-click closed the preview the first one opened
  await sent.dblclick();
  const preview = page.getByRole('dialog', { name: 'Image preview' });
  await expect(preview).toBeVisible();
  await page.waitForTimeout(400);
  await expect(preview).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('preview-after-double-click.png') });
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);

  // main's menus record their items here instead of showing; each item's action is run from the record
  const saveTo = path.join(harness.dir, 'saved-picture.png');
  await harness.app.evaluate(({ Menu, dialog, shell, clipboard }, saveTo) => {
    const g = globalThis as any;
    g.__menus = [];
    g.__revealed = [];
    Menu.prototype.popup = function (this: Electron.Menu) {
      g.__menus.push(this);
    };
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: saveTo })) as any;
    shell.showItemInFolder = (p: string) => g.__revealed.push(p);
    void clipboard.clear();
  }, saveTo);
  const menuLabels = () =>
    harness.app.evaluate(() => (globalThis as any).__menus.map((m: Electron.Menu) => m.items.map((i) => i.label || i.type)));
  const clickItem = (menu: number, label: string) =>
    harness.app.evaluate(
      (_e, [menu, label]) => (globalThis as any).__menus[menu].items.find((i: Electron.MenuItem) => i.label === label).click(),
      [menu, label] as const,
    );

  await sent.click({ button: 'right' });
  await expect.poll(menuLabels).toEqual([IMAGE_MENU]);
  await clickItem(0, 'Copy Image');
  await expect.poll(() => harness.app.evaluate(({ clipboard }) => clipboard.has('image/png'))).toBe(true);
  await clickItem(0, 'Save Image As…');
  await expect.poll(() => fs.existsSync(saveTo) && fs.readFileSync(saveTo).equals(PNG)).toBe(true);
  await clickItem(0, REVEAL);
  const revealed: string[] = await harness.app.evaluate(() => (globalThis as any).__revealed);
  expect(revealed).toHaveLength(1);
  expect(fs.readFileSync(revealed[0]).equals(PNG)).toBe(true);

  // the open preview's picture has the same menu
  await sent.click();
  await preview.locator('img').click({ button: 'right' });
  await expect.poll(async () => (await menuLabels())[1]).toEqual(IMAGE_MENU);
  await page.keyboard.press('Escape');

  // the composer gets the edit menu from main's own context-menu handler
  await composer(page).fill('some words');
  await composer(page).click({ button: 'right' });
  await expect
    .poll(async () => (await menuLabels())[2])
    .toEqual(['Undo', 'Redo', 'separator', 'Cut', 'Copy', 'Paste', 'separator', 'Select All']);
});
