// This Mac's harness picker with Claude Code signed out (#5117): the row's Sign in is a pressable action, so nothing around it is announced as disabled (no aria-disabled ancestor, the row says data-disabled), and pressing it starts `claude auth login`.
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';

// Codex is usable and Claude Code is signed out (fake-claude's signed-out marker), as in cuj-first-launch-harness-detect
test.use({ harnesses: 'codex', seed: { uiState: { prefs: SYSTEM_THEME.prefs } } });

test('local-picker-row-actions: a signed-out row keeps Sign in enabled and not announced as disabled, and pressing it signs in', async ({
  page,
  harness,
}) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await openHarnessList(page);
  const row = page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' });
  await expect(row).toContainText('Signed out');
  const signIn = row.getByRole('menuitem', { name: 'Sign in', exact: true });
  await expect(signIn).toBeVisible();
  await expect(signIn).toBeEnabled();
  // the row's choice is disabled (dimmed, no flyout), its action is not
  await expect(row).toHaveAttribute('data-disabled', 'true');
  await expect(row).not.toHaveAttribute('aria-disabled', /.*/);
  const disabledAncestors = await signIn.evaluate((el) => {
    const found: string[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) if (n.getAttribute('aria-disabled') === 'true') found.push(n.className);
    return found;
  });
  expect(disabledAncestors).toEqual([]);
  await shootBoth(page, harness.app, 'local-picker-signed-out-row', { animations: 'disabled' });

  await signIn.click();
  // `claude auth login` runs in the embedded terminal
  await expect
    .poll(() => harness.claudeLog().some((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth login'), { timeout: 30_000 })
    .toBe(true);
});
