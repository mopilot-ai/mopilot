// Picking a scope on MoPilot's own site and app cards, which read as Claude Desktop's site card: the primary
// scope is a button beside Deny, and the other scopes sit in its chevron's menu.
import type { Locator } from '@playwright/test';

/** Allows with the scope named `label`: the primary button when it is that scope, else the item in the chevron's menu. */
export async function pickScope(card: Locator, label: RegExp): Promise<void> {
  // a card that shows each scope as its own button (the desktop access card)
  const direct = card.locator('.approval-foot > button.ap-btn').filter({ hasText: label });
  if (await direct.count()) return direct.first().click();
  const primary = card.locator('.approval-foot .ap-split > .ap-btn.allow:not(.chevron)');
  if (label.test((await primary.textContent()) ?? '')) return primary.click();
  await card.getByRole('button', { name: 'Approval options' }).click();
  await card.page().getByRole('menuitem', { name: label }).click();
}
