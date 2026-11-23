// CUJ pr-and-ci (and the Code Review page's pull request path) against a fake gh: a chat in a git project tracks its pull request, the Changes card shows the failing check, Auto-fix (in the PR's menu) sends that check back to the chat on its own harness, and Code Review opens the pull request and reviews it in a new chat.
// e2e-covers: src/components/panels/PrCreateForm.tsx src/components/panels/PullRequestRow.tsx src/components/panels/useLocalSummaryRepo.ts
// Status copy is owned by 'src/components/thread/PrMonitor.tsx'; changes there must select this journey.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { claudeChatMessages, claudeTextOf } from './fixtures/claudeChat';
import { PR_URL, fakeGhBin } from './fixtures/fakeGh';
import { openHarnessList } from './fixtures/harnessPicker';
import { withPath } from './fixtures/nodeCommand';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const prBar = (page: Page) => page.getByRole('group', { name: 'Pull request controls' });

// gh is found on the login shell's PATH, then the app's (electron/platform/env.cjs gitEnv): the fake comes first on both
const { dir: BIN, log: GH_LOG } = fakeGhBin(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-')));
const ghCalls = (): string[][] => readJsonLineLog(GH_LOG);

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function pick(page: Page, who: 'Codex' | 'Claude Code', model: string) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: who }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
  await page.keyboard.press('Escape');
}
const expectIdle = (page: Page) => expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

/** A git project with a GitHub remote, added from the sidebar (the folder picker is stubbed). */
async function addProject(h: Harness) {
  const folder = path.join(h.dir, 'home', 'work', 'demo');
  fs.mkdirSync(folder, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: folder });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: folder });
  await h.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as any;
  }, folder);
  await sidebar(h.page).getByRole('button', { name: 'Add new project' }).click();
  await expect(sidebar(h.page).locator('.project-row', { hasText: 'demo' })).toBeVisible();
  return folder;
}

// The tracked pull request's row in the Changes card is one line: state, #N title, CI and ⋯ side by side, left to right.
// Unit tests run without the cascade, so a stylesheet that stacks it (0.3.48's global .pr-row, #2025) shows only here.
async function expectTrackedRowOnOneLine(page: Page) {
  const row = prBar(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'More PR options' }) });
  const parts = [
    row.getByRole('img', { name: /^(Open|Merged|Closed)$/ }),
    row.getByRole('button', { name: /^Open pull request #\d+ on GitHub$/ }),
    row.getByRole('img', { name: /^CI: / }),
    row.getByRole('button', { name: 'More PR options' }),
  ];
  const rowBox = (await row.boundingBox())!;
  expect(rowBox.height, 'the tracked pull request row wraps onto more than one line').toBeLessThan(40);
  const boxes = await Promise.all(parts.map(async (p) => (await p.boundingBox())!));
  for (let i = 1; i < boxes.length; i++) {
    const [a, b] = [boxes[i - 1], boxes[i]];
    expect(b.x, `part ${i} is not to the right of part ${i - 1}`).toBeGreaterThan(a.x);
    // vertically overlapping: each starts above where the other ends
    expect(b.y < a.y + a.height && a.y < b.y + b.height, `parts ${i - 1} and ${i} are on different lines`).toBe(true);
  }
}

async function journey(page: Page, harness: Harness, who: 'Codex' | 'Claude Code', model: string, fake: string) {
  await expect(home(page)).toBeVisible();
  await addProject(harness);
  // adding a project opens a new chat in it
  await expect(page.getByRole('button', { name: 'Change project: demo' })).toBeVisible();
  await pick(page, who, model);
  await send(page, 'push the parser fix');
  await expect(transcript(page).getByText(`${fake}: push the parser fix`, { exact: true })).toBeVisible();
  await expectIdle(page);

  // 1. the Summary panel offers a pull request for the branch (none yet); the user tracks the one the agent opened
  const summary = page.locator('.summary-panel');
  const create = summary.locator('.summary-row', { hasText: 'Pull request' }).filter({ hasText: 'Create' });
  await expect(create).toBeVisible();
  // Create opens the app's own form (electron/platform/prCreate.cjs), not the browser; this folder has no commit to
  // open a pull request from, and the form says so
  await create.click();
  const createForm = summary.getByRole('form', { name: 'Create pull request' });
  await expect(createForm.getByRole('alert')).toContainText('not on a branch with commits');
  expect(ghCalls().some((a) => a[0] === 'pr' && a[1] === 'create')).toBe(false);
  await createForm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(createForm).toHaveCount(0);
  await summary.getByTitle('More').click();
  await page.getByText('Track pull request…', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Pull request URL' }).fill(PR_URL);
  await page.getByRole('button', { name: 'Track', exact: true }).click();
  await expect(page.getByText('Pull request attached', { exact: true })).toBeVisible();
  // the app read it through the fake gh (not a gh the machine has installed)
  await expect
    .poll(() => ghCalls().some((a) => a[0] === 'pr' && a[1] === 'view' && a[2] === PR_URL), { message: 'the app did not run the fake gh' })
    .toBe(true);

  // 2. the Changes card shows the failing check, and nothing sits above the composer (#2042)
  await expect(prBar(page).getByRole('img', { name: 'CI: 1 check failing' })).toBeVisible();
  await expect(page.locator('.summary-panel').getByRole('group', { name: 'Pull request controls' })).toBeVisible();
  await expect(page.locator('.thread-composer-area').getByRole('group', { name: 'Pull request controls' })).toHaveCount(0);
  await expectTrackedRowOnOneLine(page);

  // 3. Auto-fix, a checked item in the PR's menu, sends the failing check to the chat, on this chat's harness
  const autoFix = page.getByRole('menuitemcheckbox', { name: 'Auto-fix' });
  await prBar(page).getByRole('button', { name: 'More PR options' }).click();
  if ((await autoFix.getAttribute('aria-checked')) !== 'true') await autoFix.click();
  else await page.keyboard.press('Escape');
  await prBar(page).getByRole('button', { name: 'More PR options' }).click();
  await expect(autoFix).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await prBar(page).getByRole('button', { name: 'More PR options' }).click();
  await page.getByText('Refresh status', { exact: true }).click();
  await expect(
    transcript(page)
      .getByText(/Failing check: unit-tests/)
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  await expectIdle(page);
  if (fake === 'fake-codex') {
    const starts = harness
      .codexLog()
      .filter((e) => e.method === 'turn/start' && !/as a short chat title/.test(e.params.input?.[0]?.text ?? ''));
    expect(JSON.stringify(starts.at(-1)?.params)).toContain('Failing check: unit-tests');
  } else {
    // the chat's own messages: a /usage probe the app runs after the turn may come later in the log
    expect(claudeTextOf(claudeChatMessages(harness).at(-1))).toContain('Failing check: unit-tests');
  }
  // it was sent once, not again on the next refresh with nothing new
  await prBar(page).getByRole('button', { name: 'More PR options' }).click();
  await page.getByText('Refresh status', { exact: true }).click();
  await expect.poll(() => ghCalls().filter((a) => a[0] === 'pr' && a[1] === 'view' && a[2] === PR_URL).length).toBeGreaterThan(1);
  // the transcript shows it twice (the message and the fake's echo); the harness got it once
  const sent = () =>
    fake === 'fake-codex'
      ? harness.codexLog().filter((e) => e.method === 'turn/start' && JSON.stringify(e.params).includes('Failing check: unit-tests')).length
      : claudeChatMessages(harness).filter((m) => claudeTextOf(m).includes('Failing check: unit-tests')).length;
  await page.waitForTimeout(3000);
  expect(sent()).toBe(1);
}

// the fake gh first on the login shell's PATH, which the app searches before its own: a CI runner has a real gh installed
test.use({ harnesses: 'both', shellPath: [BIN], env: { PATH: withPath([BIN]) } });
test.beforeEach(() => fs.rmSync(GH_LOG, { force: true }));

test('pr-and-ci on Codex: track the pull request, the failing check in the Changes card, Auto-fix sends it to the chat once', async ({
  page,
  harness,
}) => {
  await journey(page, harness, 'Codex', 'Fake Model One', 'fake-codex');
});

test('pr-and-ci on Claude Code: track the pull request, the failing check in the Changes card, Auto-fix sends it to the chat once', async ({
  page,
  harness,
}) => {
  await journey(page, harness, 'Claude Code', 'Fake Sonnet', 'fake-claude');
});

test('a failed branch refresh keeps the edited pull request draft and pauses submission', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  const folder = await addProject(harness);
  execFileSync(
    'git',
    ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '--no-gpg-sign', '--allow-empty', '-qm', 'Prepare draft'],
    { cwd: folder },
  );
  await pick(page, 'Codex', 'Fake Model One');
  await send(page, 'prepare a pull request');
  await expect(transcript(page).getByText('fake-codex: prepare a pull request', { exact: true })).toBeVisible();
  await expectIdle(page);

  const summary = page.locator('.summary-panel');
  await summary.locator('.summary-row', { hasText: 'Pull request' }).filter({ hasText: 'Create' }).click();
  const form = summary.getByRole('form', { name: 'Create pull request' });
  const title = form.getByRole('textbox', { name: 'Pull request title' });
  await title.fill('My edited title');
  await form.getByRole('textbox', { name: 'Pull request description' }).fill('My edited description');

  const refresh = async () => {
    await summary.getByTitle('More').click();
    await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click();
  };
  await expect(summary.locator('.summary-project')).toHaveAttribute('title', folder);
  const moved = `${folder}-away`;
  fs.renameSync(folder, moved);
  try {
    await refresh();
    await expect(form.getByRole('status')).toHaveText('Refresh to verify this branch before creating the pull request.');
    await expect(title).toHaveValue('My edited title');
    await expect(form.getByRole('textbox', { name: 'Pull request description' })).toHaveValue('My edited description');
    await expect(form.getByRole('button', { name: 'Create pull request', exact: true })).toBeDisabled();
  } finally {
    fs.renameSync(moved, folder);
  }
  await refresh();
  await expect(form.getByRole('button', { name: 'Create pull request', exact: true })).toBeEnabled();
  await expect(title).toHaveValue('My edited title');
});

test('code-review: the Code Review page lists my pull request, shows its diff and checks, and reviews it in a new chat', async ({
  page,
}) => {
  await expect(home(page)).toBeVisible();
  await page.getByRole('button', { name: 'Code Review', exact: true }).click();
  const row = page.locator('.review-pr-row', { hasText: 'Fix the parser' });
  await expect(row).toBeVisible();
  await row.click();
  await page
    .locator('.tabs-seg')
    .getByRole('button', { name: /^Files/ })
    .click();
  await expect(page.getByText('parser.js').first()).toBeVisible();
  await page.locator('.tabs-seg').getByRole('button', { name: 'Checks' }).click();
  await expect(page.getByText('unit-tests').first()).toBeVisible();
  await page.getByRole('button', { name: 'Review in a new chat', exact: true }).click();
  await expect(
    transcript(page)
      .getByText(new RegExp(`Review pull request ${PR_URL.replace(/[/.]/g, '\\$&')}`))
      .first(),
  ).toBeVisible();
  expect(ghCalls().some((a) => a[0] === 'search' && a[1] === 'prs')).toBe(true);
});
