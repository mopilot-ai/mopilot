// The real goal timer ticks through chat switches while the fake harness sends no usage reports.
// e2e-covers: src/lib/useGoalElapsed.ts src/lib/goalClock.ts src/components/thread/GoalBar.tsx src/components/thread/ComposerPills.tsx
import { test, expect } from './fixtures/app';
import { goalCard, goalPill, expectGoalRunning } from './fixtures/goal';
import { standaloneNewChat } from './fixtures/sidebar';

test.use({ harnesses: 'codex', seed: { uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0 } } } });

test('goal timer advances between reports and across chat switches, then stops when paused', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('/goal keep working SLOW');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expectGoalRunning(page);
  const card = await goalCard(page);
  const readings = await goalPill(page).evaluate(
    (pill) =>
      new Promise<{ text: string; at: number }[]>((resolve, reject) => {
        const readings = [{ text: pill.textContent!.trim(), at: performance.now() }];
        const timeout = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Goal timer did not tick three times: ${JSON.stringify(readings)}`));
        }, 10_000);
        const observer = new MutationObserver(() => {
          const text = pill.textContent!.trim();
          if (text === readings.at(-1)!.text) return;
          readings.push({ text, at: performance.now() });
          if (readings.length === 4) {
            clearTimeout(timeout);
            observer.disconnect();
            resolve(readings);
          }
        });
        observer.observe(pill, { subtree: true, childList: true, characterData: true });
      }),
  );
  const seconds = (text: string) => {
    const match = /^(?:(\d+)m\s*)?(?:(\d+)s)?$/.exec(text)!;
    return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
  };
  for (let i = 1; i < readings.length; i++) {
    expect(seconds(readings[i].text) - seconds(readings[i - 1].text)).toBe(1);
    if (i > 1) {
      expect(readings[i].at - readings[i - 1].at).toBeGreaterThan(600);
      expect(readings[i].at - readings[i - 1].at).toBeLessThan(2000);
    }
  }
  await expect(card.locator('.goal-card-summary')).toHaveText(`${readings.at(-1)!.text} elapsed`);
  await expect(goalPill(page)).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('goal-live-timer.png') });
  await page.keyboard.press('Escape');
  const goalChat = page
    .getByRole('complementary')
    .locator('.side-row')
    .filter({ has: page.locator('.row-goal') });
  for (let switches = 0; switches < 2; switches++) {
    const before = seconds(await goalPill(page).innerText());
    await standaloneNewChat(page).click();
    await expect(goalPill(page)).toHaveCount(0);
    // At least one full second elapses with the goal pill unmounted.
    await page.waitForTimeout(1100);
    await goalChat.click();
    await expectGoalRunning(page);
    expect(seconds(await goalPill(page).innerText())).toBeGreaterThan(before);
  }
  await (await goalCard(page)).getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(goalPill(page)).toHaveText('Paused');
  const stopped = await card.locator('.goal-card-summary').innerText();
  // This wait deliberately spans two ticks to prove a paused goal remains stopped.
  await page.waitForTimeout(2100);
  await expect(card.locator('.goal-card-summary')).toHaveText(stopped);
});
