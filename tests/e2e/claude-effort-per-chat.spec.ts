// A Claude Code chat's effort is its own: a pick in another chat, which also becomes the new-chat default, neither
// shows in it nor reaches its CLI session (electron/session/keepSelection.cjs; the reported repro).
import { standaloneNewChat } from './fixtures/sidebar';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const modelButton = (page: Page) => page.getByRole('button', { name: 'Select model' });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText(`fake-claude: ${text}`, { exact: true })).toBeVisible();
}
async function effortName(page: Page) {
  if (!(await page.locator('.effort-pop').isVisible())) await modelButton(page).click();
  await expect(page.locator('.effort-pop')).toBeVisible();
  return page.locator('.effort-name').innerText();
}

/** Every effort the CLI process that ran `text` was given: at its start (--effort) or changed live (apply_flag_settings). */
function effortsFor(h: Harness, text: string) {
  const log = h.claudeLog();
  const pid = log.find((e) => e.kind === 'in' && JSON.stringify(e.msg).includes(text))?.pid;
  expect(pid).toBeDefined();
  const out: string[] = [];
  for (const e of log) {
    if (e.pid !== pid) continue;
    if (e.kind === 'argv') {
      const i = e.argv.indexOf('--effort');
      if (i >= 0) out.push(e.argv[i + 1]);
    } else if (e.msg?.request?.subtype === 'apply_flag_settings' && e.msg.request.settings?.effortLevel)
      out.push(e.msg.request.settings.effortLevel);
  }
  return out;
}

test.use({ harnesses: 'claude' });
test('an effort picked in one Claude Code chat leaves another chat on its own', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'chat A one');
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await send(page, 'chat B one');
  const before = await effortName(page);
  await page.keyboard.press('Escape');

  // chat A picks another effort (the newest chat is listed first)
  await sidebar(page).getByText('Fake chat title', { exact: true }).nth(1).click();
  await expect(transcript(page).getByText('fake-claude: chat A one', { exact: true })).toBeVisible();
  // a level other than B's, whichever end of the slider the model's default is at
  expect(await effortName(page)).toBe(before);
  await page.locator('.effort-pop').press('ArrowLeft');
  if ((await page.locator('.effort-name').innerText()) === before) await page.locator('.effort-pop').press('ArrowRight');
  const picked = await page.locator('.effort-name').innerText();
  expect(picked).not.toBe(before);
  await page.keyboard.press('Escape');
  await send(page, 'chat A two');
  await expect.poll(() => effortsFor(harness, 'chat A two')).toContain(picked.toLowerCase());

  // chat B still shows, and runs on, its own (A, just sent in, is listed first now)
  await sidebar(page).getByText('Fake chat title', { exact: true }).nth(1).click();
  await expect(transcript(page).getByText('fake-claude: chat B one', { exact: true })).toBeVisible();
  expect(await effortName(page)).toBe(before);
  await page.keyboard.press('Escape');
  await send(page, 'chat B two');
  expect(effortsFor(harness, 'chat B two')).not.toContain(picked.toLowerCase());
});
