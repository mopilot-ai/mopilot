// ACP composer density in the real renderer: provider-qualified labels, one mode menu and reachable actions in narrow panes.
// e2e-covers: src/components/composer/ContextRing.tsx src/styles/app/composer.css
import { test, expect } from './fixtures/app';
import { controlsAreSeparate } from '../support/layoutBounds';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

test.use({
  harnesses: 'none',
  seed: { uiState: { prefs: { defaultHarness: 'acp:opencode' } } },
  acp: {
    opencode: {
      usage: true,
      commands: [{ name: 'goal', description: 'Set a goal' }],
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'provider/haiku',
          options: [
            { value: 'provider/haiku', name: 'OpenCode/Claude Haiku 5.5' },
            { value: 'provider/long', name: 'Provider/A very long custom model name with additional release information' },
          ],
        },
        {
          id: 'mode',
          name: 'Session Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'build',
          options: [
            { value: 'build', name: 'build' },
            { value: 'mopilot-ask', name: 'mopilot-ask' },
            { value: 'mopilot-full', name: 'mopilot-full' },
            { value: 'plan', name: 'plan' },
          ],
        },
      ],
    },
  },
});

test('compact ACP controls fit narrow panes and retain model, permission and send actions', async ({ page }) => {
  const model = page.getByRole('button', { name: 'Select model', exact: true });
  const mode = page.getByRole('button', { name: 'Change permissions', exact: true });
  await expect(model).toHaveText('Claude Haiku 5.5');
  await expect(model).toHaveAttribute('title', 'opencode · OpenCode/Claude Haiku 5.5');
  await expect(mode).toHaveText('Build');
  await expect(page.locator('.composer-left .perm-btn')).toHaveCount(1);
  await expect(model.locator('.hp-badge')).toHaveCount(0);
  await page.locator('.composer-wrap').screenshot({ path: 'test-results/acp-composer.png' });
  await mode.click();
  await expect(page.locator('.perm-menu .menu-title')).toHaveText(['Read-only', 'Ask for approval', 'Full access', 'Build']);
  await page.locator('.perm-item', { hasText: 'Ask for approval' }).click();
  await expect(mode).toHaveText('Ask for approval');
  await model.click();
  await expect(page.locator('.acp-picker-heading')).toContainText('opencode');
  await page.locator('.acp-config .menu-item', { hasText: 'A very long custom model name' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('SETTINGS');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('[mode: null config: {"model":"provider/long","mode":"mopilot-ask"}]')).toBeVisible();
  await expect(page.locator('.context-ring')).toBeVisible();
  for (const width of [640, 420, 320]) {
    await page.locator('.composer-wrap').evaluate((el, w) => {
      (el as HTMLElement).style.width = `${w}px`;
    }, width);
    const geometry = await page.locator('.composer-footer').evaluate((footer) => {
      const box = (selector: string) => footer.querySelector(selector)!.getBoundingClientRect();
      const left = box('.composer-left'),
        right = box('.composer-right');
      const label = box('.model-name'),
        modeLabel = box('.acp-mode-trigger > span');
      const controls = ['.acp-mode-trigger', '.context-ring', '.acp-model-trigger', '.composer-icon-btn.mic', '.send-btn'].map((selector) =>
        box(selector),
      );
      const action = box('.send-btn'),
        bounds = footer.getBoundingClientRect();
      return {
        groups: [left, right].map(({ left, right, top, bottom }) => ({ left, right, top, bottom })),
        labelHeight: label.height,
        modeHeight: modeLabel.height,
        controlsFit: controls.every((control) => control.left >= bounds.left - 1 && control.right <= bounds.right + 1),
        controls: controls.map(({ left, right, top, bottom }) => ({ left, right, top, bottom })),
        actionFits: action.left >= bounds.left && action.right <= bounds.right + 1,
        oneLine: label.height <= 24 && modeLabel.height <= 24,
        sameRow: controls.every((control) => Math.abs((control.top + control.bottom) / 2 - (action.top + action.bottom) / 2) <= 0.5),
      };
    });
    expect(
      { ...geometry, overlap: !controlsAreSeparate(geometry.groups), controlsSeparate: controlsAreSeparate(geometry.controls) },
      `footer at ${width}px`,
    ).toMatchObject({
      overlap: false,
      actionFits: true,
      controlsFit: true,
      controlsSeparate: true,
      oneLine: true,
      sameRow: true,
    });
    // dictation is macOS only: the button is hidden where no speech service exists (Linux CI)
    if (process.platform === 'darwin') await expect(page.getByRole('button', { name: 'Dictate', exact: true })).toBeVisible();
    if (width === 640) await page.locator('.composer-wrap').screenshot({ path: 'test-results/acp-composer-wide.png' });
    if (width === 320) await page.locator('.composer-wrap').screenshot({ path: 'test-results/acp-composer-narrow.png' });
  }
  // A real plan mode adds its clear chip; it must share the narrow footer with the current-mode menu.
  await mode.click();
  await page.locator('.perm-item', { hasText: 'Read-only' }).click();
  await expect(page.locator('.plan-chip')).toBeVisible();
  const planControls = await page.locator('.composer-footer').evaluate((footer) => {
    const controls = [...footer.querySelectorAll('.composer-icon-btn, .acp-mode-trigger, .acp-model-trigger, .plan-chip, .send-btn')].map(
      (el) => el.getBoundingClientRect(),
    );
    return controls.map(({ left, right, top, bottom }) => ({ left, right, top, bottom }));
  });
  expect(controlsAreSeparate(planControls)).toBe(true);
  await page.getByRole('button', { name: 'Add files and more' }).click();
  await page.locator('.add-panel-item', { hasText: 'Set a goal to keep pursuing' }).click();
  await expect(page.getByRole('button', { name: 'Clear goal' })).toBeVisible();
  const goalAndPlanControls = await page.locator('.composer-footer').evaluate((footer) => {
    const controls = [
      ...footer.querySelectorAll('.composer-icon-btn, .acp-mode-trigger, .acp-model-trigger, .plan-chip, .goal-chip, .send-btn'),
    ].map((el) => el.getBoundingClientRect());
    return controls.map(({ left, right, top, bottom }) => ({ left, right, top, bottom }));
  });
  expect(controlsAreSeparate(goalAndPlanControls)).toBe(true);
  await page.getByRole('button', { name: 'Clear goal' }).click();
  await page.locator('.plan-chip').click();
  await expect(page.locator('.plan-chip')).toHaveCount(0);
  // The floating composer gives its spare width to the draft, while the hidden model control consumes none.
  await page.locator('.composer-wrap').evaluate((el) => {
    (el as HTMLElement).style.width = '640px';
    el.classList.add('pane-float-composer');
  });
  const floating = await page.locator('.composer').evaluate((el) => {
    const input = el.querySelector('.composer-input')!.getBoundingClientRect();
    const actions = el.querySelector('.composer-right')!.getBoundingClientRect();
    return { input: input.width, actions: actions.width };
  });
  expect(floating.input).toBeGreaterThan(400);
  expect(floating.actions).toBeLessThan(130);
  await page.locator('.composer-wrap').evaluate((el) => {
    el.classList.remove('pane-float-composer');
  });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('SLOW check stop');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await expect(stop).toBeVisible();
  const stopBounds = await stop.boundingBox();
  const footerBounds = await page.locator('.composer-footer').boundingBox();
  expect(stopBounds!.x + stopBounds!.width).toBeLessThanOrEqual(footerBounds!.x + footerBounds!.width + 1);
  await stop.click();
  await expect(stop).toHaveCount(0);
});
