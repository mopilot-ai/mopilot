// CUJ orchestrator-chat (docs/multi-harness/ORCHESTRATOR-CHAT.md): the user asks one Claude Code chat for a split
// task, picking the harnesses; it keeps a task list and starts two linked sessions, one on Codex and one on Claude Code
// (start_session user_asked: a harness other than the chat's stands only because the user picked it, #2084); a third
// start on the harness the user picked that isn't installed fails with a typed error and leaves nothing behind.
// The Claude Code child reports first, the Codex child while every window is closed; once neither is working main
// wakes the parent with both notes, and it carries on by itself (no user relaying) to a wrap-up box naming both.
// e2e-covers: src/components/thread/SuggestionCard.tsx src/components/thread/OfferCountdown.tsx src/components/thread/StartOptions.tsx src/styles/app/suggestCard.css
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import { test, expect, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const EVENT = '<mopilot-side-sessions-event>';

/** The orchestration journal main keeps (userData/orchestration.json). */
const journal = (h: Harness): any => {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.dir, 'userData', 'orchestration.json'), 'utf8'));
  } catch {
    return {};
  }
};
const wakes = (h: Harness) => Object.values<any>(journal(h).deliveries ?? {}).filter((d) => d.kind === 'wake');
/** User messages the fake Claude CLI processes read, as text. */
const claudeInputs = (h: Harness) =>
  h
    .claudeLog()
    .filter((l) => l.kind === 'in' && l.msg?.type === 'user')
    .map((l) => JSON.stringify((l as any).msg.message?.content));

// SLOW (the fake Codex child's turn runs until the test releases it) is written as a JSON escape: the parent's own
// message holds the brief, and a plain SLOW there would hold the fake Claude parent's turn as well
const start = (args: object) =>
  `CUCALL start_session ${JSON.stringify({
    initiation: 'user_asked',
    context: 'fresh',
    use_worktree: false,
    background:
      'These independent sessions implement the release notes task requested by the user; preserve their assigned files and report the outcome to their parent.',
    ...args,
  })
    .replace(/SLOW/g, 'SL\\u004fW')
    .replace(/APPROVECMD/g, 'APPROVEC\\u004dD')}`;

test.use({ harnesses: 'both' });

test('an orchestrator splits a task over Codex and Claude Code sessions, hears back with no window open, and wraps up by itself', async ({
  page,
  harness,
}) => {
  test.skip(process.platform !== 'darwin', 'the app stays running with no window on macOS only');
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();

  // the user's one request: the agent sets its task list, starts two sessions and tries a third on a missing harness
  const lines = [
    // the user's own words pick each harness: without them the Codex and Kimi starts would run on Claude Code
    'split the release notes into two sessions, one on Codex and one on Claude Code, and try a third with Kimi',
    `CUCALL update_task_list ${JSON.stringify({
      items: [
        { content: 'Start the two sessions', status: 'in_progress' },
        { content: 'Merge their reports', status: 'pending' },
      ],
    })}`,
    // the two share this folder, so each declares the files it writes (writeScope.cjs)
    start({ title: 'ORCHWRAP-codex notes', prompt: 'Draft the Codex half of the notes SLOW', harness: 'codex', paths: ['notes/codex.md'] }),
    start({ title: 'ORCHWRAP-claude notes', prompt: 'Draft the Claude half of the notes', harness: 'claude', paths: ['notes/claude.md'] }),
    start({ title: 'Kimi notes', prompt: 'Draft the Kimi half', harness: 'acp:kimi' }),
  ];
  await composer(page).fill(lines.join('\n'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText(/fake-claude: split the release notes/)).toBeVisible();
  // the missing harness is a typed error, and no chat is made for it
  await expect(transcript(page).getByText(/\[cu: error: [^\]]*isn't available now/)).toBeVisible();
  const parentId = await transcript(page).locator('.thread-view').getAttribute('data-thread-id');
  expect(parentId).toBeTruthy();
  const tasks = page.getByRole('region', { name: 'Task list' });
  await expect(tasks).toContainText('Start the two sessions');
  await expect(tasks).toContainText('Merge their reports');

  // both sessions nest under the orchestrator; the third was never made
  const children = sidebar(page).getByRole('group', { name: 'Sessions this chat started' });
  await expect(children.locator('.thread-row')).toHaveCount(2);
  // each is linked under the title the orchestrator gave it, on the harness it asked for (the sidebar row shows the
  // harness's own title for now: #1722)
  await expect
    .poll(() =>
      Object.values<any>(journal(harness).children ?? {})
        .map((c) => `${c.title} on ${c.harness}`)
        .sort(),
    )
    .toEqual(['ORCHWRAP-claude notes on claude', 'ORCHWRAP-codex notes on codex']);
  await expect(sidebar(page).getByText('Kimi notes')).toHaveCount(0);
  // the Claude Code session got its brief and reported; the Codex one still works, so the parent isn't woken yet
  await expect.poll(() => claudeInputs(harness).some((t) => t.includes('Draft the Claude half of the notes'))).toBe(true);
  await expect
    .poll(() => harness.codexLog().some((l) => l.method === 'turn/start' && JSON.stringify(l.params).includes('Draft the Codex half')))
    .toBe(true);
  await expect.poll(() => Object.values<any>(journal(harness).children ?? {}).filter((c) => c.lastReport).length).toBe(1);
  expect(wakes(harness)).toHaveLength(0);

  // every window closed: the Codex session finishes, and main wakes the parent with both notes
  await page.close();
  await expect.poll(() => harness.app.windows().length).toBe(0);
  fs.writeFileSync(path.join(harness.dir, 'fake-codex.jsonl.release'), '');
  await expect.poll(() => wakes(harness).length, { timeout: 30_000 }).toBe(1);
  expect(wakes(harness)[0].notes).toHaveLength(2);
  const woken = () => claudeInputs(harness).find((t) => t.includes(EVENT));
  await expect.poll(woken).toBeTruthy();
  expect(woken()).toContain('ORCHWRAP-codex');
  expect(woken()).toContain('ORCHWRAP-claude');
  // Receiving the wake is not finishing it: the fake still streams its reply after wrap_up. Prove that the
  // parent's final reply was saved while windowless before reopening its history, which retries boundedly under churn.
  await expect.poll(() => journal(harness).wrapUps?.[parentId!]?.recap).toMatch(/Wrapped up after ORCHWRAP-/);
  const projects = path.join(harness.dir, 'home', '.claude', 'projects');
  await expect
    .poll(
      () => {
        const file = fs
          .readdirSync(projects)
          .map((dir) => path.join(projects, dir, `${parentId!.slice('claude:'.length)}.jsonl`))
          .find(fs.existsSync);
        return (
          file &&
          readJsonLineLog(file).some(
            (r) =>
              r.type === 'assistant' &&
              r.message?.stop_reason === 'end_turn' &&
              r.message.content?.some((c: any) => c.type === 'text' && c.text.includes(EVENT)),
          )
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);

  // the next window: the parent shows the wake-up card with both reports and its own wrap-up box, nobody relayed anything
  await harness.app.evaluate(({ app }) => app.emit('activate'));
  const page2 = harness.app.windows()[0] ?? (await harness.app.waitForEvent('window'));
  // The new window reads family links asynchronously; wait for them, then open the captured parent id.
  await expect(sidebar(page2).getByRole('group', { name: 'Sessions this chat started' }).locator('.thread-row')).toHaveCount(2);
  await sidebar(page2)
    .locator(`[data-sidebar-chat=${JSON.stringify(parentId)}]`)
    .first()
    .click();
  await expect(transcript(page2).locator('.thread-view')).toHaveAttribute('data-thread-id', parentId!);
  const wake = transcript(page2).locator('.side-session-card[data-kind="wake"]');
  await expect(wake).toContainText('Received 2 messages');
  await expect(wake).toContainText('The app asked Claude Code to report back');
  await expect(wake.locator('.side-session-note')).toHaveCount(2);
  const box = page2.getByRole('region', { name: 'Where this stands' });
  await expect(box).toContainText(/Wrapped up after ORCHWRAP-(codex|claude) and ORCHWRAP-(codex|claude) reported back\./);
  await expect(page2.getByRole('region', { name: 'Task list' })).toHaveCount(0);
});

test.describe('CD linked-session transcript at the narrowest window', () => {
  test.use({ seed: { uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0 } } } });

  test('repeated cards keep live and settled states, mirror a child request and show Task and Context', async ({
    page,
    harness,
  }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 682 });
    await expect(home(page)).toBeVisible();
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
    await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
    await composer(page).fill(
      [
        'Start three separate sessions on Codex for the approval, producer and dependent tasks. CUSTEPS',
        start({
          title: 'Approval task',
          name: 'approval-task',
          prompt: 'APPROVECMD check the approval owner',
          harness: 'codex',
          paths: ['approval.md'],
        }),
        start({
          title: 'Producer task',
          name: 'producer-task',
          prompt: 'Produce the schema SLOW',
          harness: 'codex',
          paths: ['producer.md'],
        }),
        start({
          title: 'Dependent task',
          name: 'dependent-task',
          prompt: 'Review the schema',
          harness: 'codex',
          paths: ['dependent.md'],
          after: ['producer-task'],
        }),
      ].join('\n'),
    );
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const cards = transcript(page).locator('.session-card');
    await expect(cards).toHaveCount(3);
    const parentId = await transcript(page).locator('.thread-view').getAttribute('data-thread-id');
    expect(parentId).toBeTruthy();
    await expect(cards.filter({ hasText: 'Dependent task' })).toContainText('Waits for producer-task');
    await expect(cards.filter({ hasText: 'Producer task' }).locator('.session-card-dot')).toBeVisible();
    await expect(transcript(page).locator('.session-card-usage')).toHaveCount(0);
    const request = page.locator('.thread-column .needs-you-row');
    await expect(request).toHaveCount(1);
    await expect(request).toContainText('Request from');
    await expect(request).toContainText('Needs input');
    await expect(request.locator('.approval-card')).toBeVisible();
    await expect(request.locator('[aria-expanded="true"]')).toBeVisible();
    await expect(page.locator('.thread-composer-area .needs-you-row')).toHaveCount(0);
    const bounds = await cards.evaluateAll((nodes) =>
      nodes.map((node) => {
        const card = node.getBoundingClientRect();
        const column = node.closest('.thread-column')!.getBoundingClientRect();
        return { width: card.width, fits: card.left >= column.left - 1 && card.right <= column.right + 1 };
      }),
    );
    expect(bounds.every((b) => b.width > 0 && b.fits)).toBe(true);
    const actions = await request.locator('.approval-foot button:visible').evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
        const textRects: { left: number; top: number; right: number; bottom: number }[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects())
            textRects.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
        }
        return {
          label: button.textContent?.trim() ?? '',
          textRects,
          fits: textRects.every(
            (rect) => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1,
          ),
        };
      }),
    );
    expect(actions.some((action) => /Allow\s+once/.test(action.label) && action.textRects.length > 0)).toBe(true);
    expect(actions.every((action) => action.fits)).toBe(true);
    await testInfo.attach('approval-action-text-geometry', { body: JSON.stringify(actions), contentType: 'application/json' });
    const permission = page.getByRole('button', { name: 'Change permissions', exact: true });
    await expect(permission.locator(':scope > span')).toBeHidden();
    await expect(permission.locator(':scope > svg').first()).toBeVisible();
    const permissionLayout = await permission.evaluate((button) => {
      const label = button.querySelector('span')!;
      const range = document.createRange();
      range.selectNodeContents(label);
      const box = button.getBoundingClientRect();
      const icon = button.querySelector('svg')!.getBoundingClientRect();
      const composerBox = button.closest('.composer')!.getBoundingClientRect();
      const rects = [...range.getClientRects()];
      return {
        text: label.textContent,
        lines: rects.length,
        width: box.width,
        fitsButton: icon.left >= box.left - 1 && icon.right <= box.right + 1 && icon.top >= box.top - 1 && icon.bottom <= box.bottom + 1,
        fitsComposer: box.left >= composerBox.left && box.right <= composerBox.right,
      };
    });
    expect(permissionLayout.text).toBe('Ask for approval');
    expect(permissionLayout.lines).toBe(0);
    expect(permissionLayout.width).toBe(28);
    expect(permissionLayout.fitsButton).toBe(true);
    expect(permissionLayout.fitsComposer).toBe(true);
    await permission.click();
    const currentPermission = page.getByRole('menuitemradio', { name: /^Ask for approval/ });
    await expect(currentPermission).toBeVisible();
    await expect(currentPermission).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(currentPermission).toHaveCount(0);
    const cardGroup = transcript(page)
      .locator('.turn .work')
      .filter({ has: page.locator('.session-card', { hasText: 'Producer task' }) });
    await expect(cardGroup).toHaveCount(1);
    await expect(cardGroup.locator('.session-card')).toHaveCount(3);
    const cardTurnSlot = await cardGroup.evaluate((group) => group.closest<HTMLElement>('[data-turn-slot]')?.dataset.turnSlot ?? null);
    expect(cardTurnSlot).not.toBeNull();
    await cardGroup.screenshot({ path: testInfo.outputPath('linked-card-group-working-1024-font24.png') });
    await request.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('linked-cards-working-1024-font24.png') });
    await request.getByRole('button', { name: /Allow once/ }).click();
    await expect(request).toHaveCount(0);
    const approval = Object.entries<any>(journal(harness).children ?? {}).find(([, child]) => child.title === 'Approval task');
    expect(approval).toBeTruthy();
    const [approvalId] = approval!;
    await expect.poll(() => journal(harness).children[approvalId]?.lastReport?.how).toBe('finished');
    // Its successful report is unread while the user stays in the parent; idle keeps its quiet ring without a state word.
    await expect(cards.filter({ hasText: 'Approval task' })).toHaveAttribute('data-state', 'idle');
    await expect(cards.filter({ hasText: 'Approval task' }).locator('.session-card-word')).toHaveCount(0);
    await expect(cards.filter({ hasText: 'Approval task' }).locator('.session-card-dot')).toHaveAttribute('data-dot', 'idle');
    await cards.filter({ hasText: 'Producer task' }).click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await sidebar(page)
      .locator(`[data-sidebar-chat=${JSON.stringify(parentId)}]`)
      .first()
      .click();
    await expect(transcript(page).locator('.thread-view')).toHaveAttribute('data-thread-id', parentId!);
    // Returning opens on the new wake reply; scroll the original turn's persistent slot to materialize its cards again.
    await transcript(page)
      .locator(`[data-turn-slot=${JSON.stringify(cardTurnSlot)}]`)
      .scrollIntoViewIfNeeded();
    await expect(cardGroup).toHaveCount(1);
    await expect(cards).toHaveCount(3);
    await expect(cards.filter({ hasText: 'Dependent task' })).toContainText('Held: producer-task was stopped');
    await expect(cardGroup.locator('.session-card')).toHaveCount(3);
    await cardGroup.screenshot({ path: testInfo.outputPath('linked-card-group-settled-1024-font24.png') });
    await page.screenshot({ path: testInfo.outputPath('linked-cards-settled-1024-font24.png') });
    await composer(page).fill(`CUSTEPS\nCUCALL start_session ${JSON.stringify({ initiation: 'offer', title: 'Follow-up options' })}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const suggestion = transcript(page).getByRole('group', { name: '1 suggested task', exact: true });
    // an offer nobody answered yet counts down to "Do it here": the seconds under its title, and that answer filling
    const countdown = suggestion.locator('.suggest-row-countdown');
    await expect(countdown).toHaveText(/^Doing it here in \d+s$/);
    await expect(suggestion.getByRole('button', { name: /^Do it here/ })).toHaveClass(/offer-countdown-fill/);
    await suggestion.screenshot({ path: testInfo.outputPath('offer-countdown-1024-font24.png') });
    // where the row runs opens its start options (#3675 folded the Options pill into it); its words follow the place, its title does not
    await suggestion.getByTitle('Start options', { exact: true }).click();
    // taking the card in hand holds the countdown: the card waits for the user's answer
    await expect(countdown).toHaveCount(0);
    const options = page.getByRole('dialog', { name: 'Session start options', exact: true });
    await expect(options).toBeVisible();
    await expect(options.getByRole('combobox', { name: 'Session model', exact: true })).toBeVisible();
    await expect(options.getByRole('combobox', { name: 'Session effort', exact: true })).toBeVisible();
    await expect(options.getByRole('combobox', { name: 'Session permissions', exact: true })).toBeVisible();
    const popup = await options.boundingBox();
    expect(popup && popup.width <= 456 && popup.x >= 0 && popup.x + popup.width <= 1024).toBeTruthy();
    const surface = await options.evaluate((node) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return {
        background: style.backgroundColor,
        borderWidth: parseFloat(style.borderTopWidth),
        borderColor: style.borderTopColor,
        radius: parseFloat(style.borderTopLeftRadius),
        shadow: style.boxShadow,
        selects: [...node.querySelectorAll('select')].map((select) => {
          const own = getComputedStyle(select);
          const label = getComputedStyle(select.parentElement!);
          const bounds = select.getBoundingClientRect();
          return {
            appearance: own.appearance,
            inheritsFont: own.fontFamily === label.fontFamily && own.fontSize === label.fontSize,
            background: own.backgroundColor,
            fits: bounds.left >= box.left && bounds.right <= box.right && bounds.top >= box.top && bounds.bottom <= box.bottom,
          };
        }),
      };
    });
    expect(surface.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(surface.borderWidth).toBeGreaterThan(0);
    expect(surface.borderColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(surface.radius).toBeGreaterThan(0);
    expect(surface.shadow).not.toBe('none');
    expect(surface.selects.length).toBeGreaterThanOrEqual(4);
    expect(surface.selects.every((select) => select.appearance === 'none' && select.inheritsFont && select.fits)).toBe(true);
    expect(surface.selects.every((select) => select.background !== 'rgba(0, 0, 0, 0)')).toBe(true);
    await testInfo.attach('session-options-surface', { body: JSON.stringify(surface), contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('linked-options-1024-font24.png') });
    await page.keyboard.press('Escape');
    await expect(options).toHaveCount(0);
    await suggestion.getByRole('button', { name: /^Do it here/ }).click();
    await transcript(page)
      .locator(`[data-turn-slot=${JSON.stringify(cardTurnSlot)}]`)
      .scrollIntoViewIfNeeded();
    await expect(cardGroup).toHaveCount(1);
    await expect(cardGroup.locator('.session-card')).toHaveCount(3);
    await cards.filter({ hasText: 'Approval task' }).click();
    const brief = transcript(page).locator('.side-session-brief');
    await expect(brief).toContainText('Started by Claude Code from');
    await expect(brief.locator('.side-session-brief-step')).toHaveCount(2);
    await expect(brief.getByRole('button', { name: 'Task actions', exact: true })).toBeVisible();
    await expect(brief.getByRole('button', { name: 'Context actions', exact: true })).toBeVisible();
    await brief.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('linked-task-context-1024-font24.png') });
  });
});
