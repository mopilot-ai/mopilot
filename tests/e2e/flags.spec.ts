// Remote kill switches in the real app: with the flags server unreachable, the renderer sees the
// built-in defaults through the preload bridge.
import { test, expect } from './fixtures/app';
import { ACP_CATALOG, ACP_IDS } from '../../shared/harnessCatalog.mjs';

test('flags: offline, the renderer reads the built-in defaults', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const flags = await page.evaluate(() => (window as any).native.flags.all());
  expect(flags['harness.codex.enabled']).toBe(true);
  // computer use is the macOS helper's: its switches default off in a Windows build (shared/flagDefs.mjs NOT_ON_WINDOWS)
  expect(flags['shared.computerUse.unattended']).toBe(process.platform !== 'win32');
  // each basic harness ships on or off as its catalog entry says (a harness turned on there is on here too)
  expect(Object.fromEntries(ACP_IDS.map((id) => [id, flags[`harness.acp.${id}.enabled`]]))).toEqual(
    Object.fromEntries(ACP_IDS.map((id) => [id, ACP_CATALOG[id].enabled])),
  );
  expect(await page.evaluate(() => (window as any).native.flags.isEnabled('harness.claude.enabled'))).toBe(true);
  expect(await page.evaluate(() => (window as any).native.flags.isEnabled('no.such.flag'))).toBe(false);
});
