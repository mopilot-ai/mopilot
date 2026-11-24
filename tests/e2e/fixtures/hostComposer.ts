// Drives the remote composer’s model picker and its usage ring against the resident fake Host.
import { rmSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, type test } from './app';

export const AGENT_LABEL: Record<string, string> = { kimi: 'Kimi Code', claude: 'Claude Code', codex: 'Codex' };

export async function pickMachineModel(page: Page, agent: string) {
  await page.getByRole('button', { name: 'Select model', exact: true }).click();
  await page.getByRole('button', { name: 'Select harness and model', exact: true }).click();
  await page.locator('.hp-row', { hasText: AGENT_LABEL[agent] }).hover();
  await page.getByRole('menuitemradio', { name: `${agent} Remote other`, exact: true }).click();
}

export function testHostUsageRing(
  run: typeof test,
  {
    pickTarget,
    send,
    calls,
    releaseFile,
  }: {
    pickTarget: (page: Page) => Promise<void>;
    send: (page: Page, text: string) => Promise<void>;
    calls: () => { method: string; params: { harness?: unknown } }[];
    releaseFile: string;
  },
) {
  run('a remote Claude Code chat keeps its usage ring available through the first turn', async ({ page }) => {
    rmSync(releaseFile, { force: true });
    await pickTarget(page);
    await pickMachineModel(page, 'claude');
    await page.keyboard.press('Escape');

    const ring = page.locator('.context-ring');
    const panel = page.getByRole('dialog', { name: 'Usage', exact: true });
    const stop = page.getByRole('button', { name: 'Stop', exact: true });
    await expect(ring).toHaveAccessibleName('Usage details');
    await ring.click();
    await expect(panel).toContainText('No context usage reported yet.');
    await page.keyboard.press('Escape');
    await send(page, 'report context');
    await expect(stop).toBeVisible({ timeout: 30_000 });
    expect(calls().find((call) => call.method === 'chat.start')?.params.harness).toBe('claude');
    await expect(ring).toHaveAccessibleName('Usage details');
    await ring.click();
    await expect(panel).toContainText('No context usage reported yet.');
    await expect(panel.getByRole('meter')).toHaveCount(0);

    writeFileSync(releaseFile, '');
    await expect(ring).toHaveAccessibleName('Context: 4% used, 40k of 1M tokens');
    await expect(panel.getByRole('meter', { name: 'Context used' })).toHaveAttribute('aria-valuenow', '4');
    await expect(stop).toHaveCount(0);
  });
}
