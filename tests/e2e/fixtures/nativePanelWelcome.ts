// Native panel onboarding waits for visible readiness before trusted clicks, so a pending storage read cannot undo the fixture's consent.
import { expect } from '@playwright/test';
import type { NativePanel } from './extensionChrome';

export async function completePanelFirstRun(panel: Pick<NativePanel, 'inPanel' | 'click'>) {
  await expect.poll(() => panel.inPanel(`document.getElementById('welcome')?.hidden === false`), { timeout: 30_000 }).toBe(true);
  await panel.click('#consent-ok');
  await expect.poll(() => panel.inPanel(`document.getElementById('intro')?.hidden`), { timeout: 30_000 }).toBe(false);
  await panel.click('#intro-next');
  await expect.poll(() => panel.inPanel(`document.getElementById('intro-next')?.textContent`), { timeout: 30_000 }).toBe('Let’s go');
  await panel.click('#intro-next');
  await expect.poll(() => panel.inPanel(`document.getElementById('composer')?.hidden`), { timeout: 30_000 }).toBe(false);
}
