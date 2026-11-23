// "N sessions need you" under a chat's turn counts only the sessions blocked on the user, and opens the first (#3403):
// after a restart an archived session whose last turn failed is not counted (the Settings archive list is not loaded
// yet), an idle session with a report is not counted, and a session held on an approval card is, with the click
// landing in that session on its card.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Harness } from './fixtures/app';
import { archiveSidebarChat } from './fixtures/sidebar';
import { BRIEF, backToParent, claudeProject, holdOnApproval, journal, send, sidebar } from './fixtures/linkedFamily';

test.use({ harnesses: 'claude' });

const children = (h: Harness) => Object.entries<any>(journal(h).children ?? {});

test('needs you counts only sessions blocked on the user, across a restart, and opens the first', async ({ harness }, testInfo) => {
  test.setTimeout(300_000);
  let page = harness.page;
  await claudeProject(page, harness, 'needs-you-project');
  const start = (title: string, name: string) =>
    `CUCALL start_session ${JSON.stringify({ initiation: 'user_asked', context: 'fresh', use_worktree: false, name, title, prompt: 'Stand by', background: BRIEF })}`;
  const finished = () => children(harness).filter(([, c]) => c.lastReport?.how === 'finished').length;
  // one session per turn, each run to its report
  await send(page, `Start a session CUSTEPS\n${start('Gap audit', 'gap-audit')}`);
  await expect.poll(finished, { timeout: 90_000 }).toBe(1);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
  await send(page, `Start another CUSTEPS\n${start('Device worker', 'device-worker')}`);
  await expect.poll(finished, { timeout: 90_000 }).toBe(2);
  const [[auditId, audit], [workerId]] = children(harness).sort(([, a], [, b]) =>
    a.name === 'gap-audit' ? -1 : b.name === 'gap-audit' ? 1 : 0,
  );
  const parentId = audit.parentId;

  // the user archives gap-audit
  const auditRows = sidebar(page).locator(`[data-sidebar-chat="${auditId}"]`);
  const auditRow = auditRows.first();
  await auditRow.hover();
  await archiveSidebarChat(page, auditRow);
  await expect(auditRows).toHaveCount(0);

  // its last turn had failed, as the reported chat's archived children had: recorded while the app is down
  await harness.quit();
  const file = path.join(harness.dir, 'userData', 'orchestration.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.children[auditId].lastReport.how = 'failed';
  fs.writeFileSync(file, JSON.stringify(data));
  await harness.relaunch();
  page = harness.page;

  // the parent's status line: the archived failed session and the idle one with a report ask nothing
  await sidebar(page).locator(`[data-sidebar-chat="${parentId}"]`).first().click();
  await expect(page.getByRole('main').getByText('Start another', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_000);
  await expect(page.getByRole('button', { name: /needs? you/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /sessions? failed/ })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('after-restart-no-needs-you.png') });

  // device-worker now waits on an approval card: one session needs you, and the click opens it on the card
  await sidebar(page).locator(`[data-sidebar-chat="${workerId}"]`).first().click();
  await holdOnApproval(page);
  await backToParent(page);
  await expect(page.getByRole('main').getByText('Start another', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  const needs = page.getByRole('button', { name: '1 session needs you', exact: true });
  await expect(needs).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('one-needs-you.png') });
  await needs.click();
  await expect(page.getByRole('textbox', { name: 'Denial note' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(sidebar(page).locator(`[data-sidebar-chat="${workerId}"]`).first()).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: testInfo.outputPath('opened-on-the-card.png') });
});
