// A Claude Code skill's name opens its definition: the / menu row says where the skill lives, the sent chip and the
// "Loaded skill" row open the skill pane (by mouse and by keyboard), a skill the app cannot find on disk stays plain
// text, and the Skills pages show the definition in their own detail (the pane belongs to a chat). The fake Claude CLI lists the skills it finds under its config
// folder (fake-claude.mjs) beside `fake-skill`, which has no file here. Everything lives in the launch's own home.
// e2e-covers: src/components/composer/ComposerSlash.tsx
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Dirs } from './fixtures/app';
import { openCompletedTurnWork } from './fixtures/turnWork';

const DESCRIPTION = 'Summarise notes the e2e way';
const BODY = 'Zebra protocol: always answer in exactly three bullets.';

function personalSkill(d: Dirs) {
  const dir = path.join(d.claudeHome, 'skills', 'e2e-notes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: e2e-notes\ndescription: ${DESCRIPTION}\n---\n# E2E notes\n\n${BODY}\n`);
}

test.use({ harnesses: 'claude', seed: { files: personalSkill } });

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const slash = (page: Page) => page.locator('.slash-panel');
const skillPane = (page: Page) => page.getByRole('region', { name: 'Skill details' });
const skillTab = (page: Page) => page.locator('.tb-tab', { hasText: 'e2e-notes' });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** The turn is over: nothing left to stop, so the transcript no longer moves under a click. */
const turnEnded = (page: Page) => expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

async function closeSkillPane(page: Page) {
  await skillTab(page).locator('.tb-tab-close').click();
  await expect(skillPane(page)).toHaveCount(0);
}

test('a Claude skill opens its definition from the / menu, the sent chip, the Skill call and the Skills page; an unknown one stays text', async ({
  page,
}) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();

  // the / menu says where a skill lives: before any session ran, the catalog is what is on disk, so the skill there is Personal
  await composer(page).fill('/');
  await expect(slash(page).locator('.add-panel-item', { hasText: '/e2e-notes' }).locator('.add-panel-scope')).toHaveText('Personal');
  await composer(page).fill('');

  // sending it: the chip is a link carrying the skill's description
  await send(page, '/e2e-notes summarize this');
  await expect(transcript(page).getByText('fake-claude: /e2e-notes summarize this', { exact: true })).toBeVisible();
  const chip = transcript(page).locator('a.bubble-skill', { hasText: '/e2e-notes' });
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute('title', DESCRIPTION);

  // the session has listed its skills now: the one with no file on disk is a plain Skill, the one on disk still Personal
  await composer(page).fill('/fake');
  await expect(slash(page).locator('.add-panel-item', { hasText: '/fake-skill' }).locator('.add-panel-scope')).toHaveText('Skill');
  await composer(page).fill('/e2e');
  await expect(slash(page).locator('.add-panel-item', { hasText: '/e2e-notes' }).locator('.add-panel-scope')).toHaveText('Personal');
  await composer(page).fill('');

  // a click opens the skill pane with the description and the body
  await chip.click();
  await expect(skillPane(page)).toBeVisible();
  await expect(skillPane(page)).toContainText(DESCRIPTION);
  await expect(skillPane(page)).toContainText(BODY);
  await expect(skillTab(page)).toBeVisible();

  // closed, the chip opens it again from the keyboard
  await closeSkillPane(page);
  await chip.focus();
  await expect(chip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(skillPane(page)).toContainText(BODY);
  await closeSkillPane(page);

  // the Skill tool call's row reads as before, and its name opens the same pane
  const asked = 'now load it SKILLCALL e2e-notes';
  await send(page, asked);
  await expect(transcript(page).getByText(`fake-claude: ${asked}`, { exact: true })).toBeVisible();
  await turnEnded(page);
  // once the turn ends its steps sit under "Worked for"
  const turn = await openCompletedTurnWork(page, asked);
  const loaded = turn.locator('.step-text', { hasText: 'Loaded skill /e2e-notes' });
  await expect(loaded).toBeVisible();
  await loaded.getByRole('button', { name: '/e2e-notes' }).click();
  await expect(skillPane(page)).toContainText(BODY);
  await closeSkillPane(page);

  // a skill with no file on disk is plain text: no link, and a click opens nothing and says nothing
  await send(page, '/fake-skill tidy up');
  await expect(transcript(page).getByText('fake-claude: /fake-skill tidy up', { exact: true })).toBeVisible();
  await turnEnded(page);
  const plain = transcript(page).locator('span.bubble-skill', { hasText: '/fake-skill' });
  await expect(plain).toHaveCount(1);
  await expect(transcript(page).locator('a.bubble-skill', { hasText: '/fake-skill' })).toHaveCount(0);
  await plain.click();
  await expect(skillPane(page)).toHaveCount(0);
  await expect(page.locator('.tb-tab', { hasText: 'fake-skill' })).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveCount(0);

  // the Skills page, once nothing is running: the card's detail is the definition (the pane belongs to a chat, so no Open here)
  await turnEnded(page);
  await page.getByRole('button', { name: 'Plugins' }).first().click();
  await page.getByRole('button', { name: 'Skills' }).first().click();
  await expect(page.locator('.ext-harness-tabs .segmented button.on')).toHaveText('All harnesses');
  await page.locator('.plugin-card', { hasText: /e2e.?notes/i }).click();
  const detail = page.locator('.skill-detail');
  await expect(detail).toContainText(BODY);
  await expect(detail.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0);
  await detail.getByRole('button', { name: 'Close' }).click();
  await expect(detail).toHaveCount(0);

  // the Claude Code tab lists its skills: the one with a file opens the same detail, the one without is text
  await page.locator('.ext-harness-tabs .segmented button', { hasText: 'Claude Code' }).click();
  await expect(page.locator('.plugins-page')).toContainText('Skills Claude Code has found');
  await expect(page.locator('.plugins-page').getByRole('button', { name: 'fake-skill' })).toHaveCount(0);
  await page.locator('.plugins-page').getByRole('button', { name: 'e2e-notes', exact: true }).click();
  await expect(detail).toContainText(BODY);
  await expect(skillPane(page)).toHaveCount(0);
});
