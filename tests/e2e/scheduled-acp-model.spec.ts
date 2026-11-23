// A scheduled task on a basic harness picks its model and thought level in the task dialog, from what the harness
// declares (its catalog), and a run sets them on its ACP session before the prompt: opencode's GLM, not its default.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { createdTaskText } from './fixtures/tasks';

// needs a Mac: a basic harness is admitted only with sage-mcp, which builds only on macOS
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const select = (id: string, name: string, category: string, currentValue: string, values: [string, string][]) => ({
  id,
  name,
  category,
  type: 'select',
  currentValue,
  options: values.map(([value, n]) => ({ value, name: n })),
});

test.use({
  harnesses: 'codex',
  acp: {
    opencode: {
      configOptions: [
        select('model', 'Model', 'model', 'opencode/big-pickle', [
          ['opencode/big-pickle', 'Big Pickle'],
          ['opencode/glm-5.3-flash-free', 'GLM-5.3 Flash Free'],
        ]),
        select('variant', 'Thinking', 'thought_level', 'low', [
          ['low', 'Low effort'],
          ['high', 'High effort'],
        ]),
      ],
    },
  },
});

async function pick(page: Page, label: string, option: string) {
  await page.getByRole('dialog', { name: 'Schedule a task' }).getByRole('button', { name: label }).click();
  await page
    .getByRole('menuitemcheckbox')
    .filter({ has: page.locator('.menu-title', { hasText: new RegExp(`^${option}$`) }) })
    .or(page.getByRole('menuitemcheckbox', { name: option, exact: true }))
    .click();
}

test('scheduled-acp-model: an opencode task picks GLM and high thinking, and its run sets them before the prompt', async ({
  page,
  harness,
}, testInfo) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await page.getByRole('button', { name: 'Scheduled' }).first().click();
  await page.locator('.sched-template', { hasText: 'Weekly finances update' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule a task' });
  await dialog.getByPlaceholder('Instructions...').fill('check the merge system');
  await dialog.getByRole('button', { name: 'Advanced' }).click();
  await pick(page, 'Run with', 'opencode');

  // the harness's own models, starting on its current one; no "Uses the model set in opencode" dead end
  await expect(dialog.getByText(/Uses the model set in/)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Model' })).toContainText('Big Pickle');
  await expect(dialog.getByRole('button', { name: 'Reasoning' })).toContainText('Low effort');
  await pick(page, 'Model', 'GLM-5.3 Flash Free');
  await pick(page, 'Reasoning', 'High effort');
  await page.screenshot({ path: testInfo.outputPath('scheduled-acp-model-dialog.png'), animations: 'disabled' });
  await dialog
    .getByRole('button', { name: /^Save|Create|Schedule$/ })
    .last()
    .click();
  await expect(page.getByText('Scheduled task saved')).toBeVisible();

  const text = () => createdTaskText(path.join(harness.dir, 'home', '.mopilot', 'automations'), 'Weekly finances update');
  await expect.poll(text).toContain('harness = "acp:opencode"');
  expect(text()).toContain('model = "opencode/glm-5.3-flash-free"');
  expect(text()).toContain('reasoning_effort = "high"');

  // Run now: the session is set to the task's model and thinking, then prompted
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByRole('main').getByText('fake-acp: check the merge system', { exact: true })).toBeVisible();
  const calls = harness
    .acpLog('opencode')
    .filter((l) => l.kind === 'in' && !JSON.stringify(l).includes('mopilot-acp-probe-'))
    .map((l) => l.msg?.method)
    .filter((m) => m === 'session/set_config_option' || m === 'session/prompt');
  const sets = harness
    .acpLog('opencode')
    .filter((l) => l.kind === 'in' && l.msg?.method === 'session/set_config_option')
    .map((l) => [l.msg.params.configId, l.msg.params.value]);
  expect(sets).toEqual(
    expect.arrayContaining([
      ['model', 'opencode/glm-5.3-flash-free'],
      ['variant', 'high'],
    ]),
  );
  expect(calls.lastIndexOf('session/set_config_option')).toBeLessThan(calls.indexOf('session/prompt'));
  await page.screenshot({ path: testInfo.outputPath('scheduled-acp-model-run.png'), animations: 'disabled' });
});
