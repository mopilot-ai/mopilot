// What the specs of a question on a machine share (host-remote-question.spec.ts, host-local-question.spec.ts): the fake Claude and Codex a Host runs, the question's form card answered, and the machine chat's picker.
// e2e-covers: src/styles/app/composer.css src/styles/app/approvals.css src/styles/app/thread-questions.css
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, FAKE_CLAUDE } from './app';
import { nodeCommand } from './nodeCommand';

/** The fake `codex` CLI a Host runs (its `app-server` and `login status`): the repo's Host fixture. */
export const FAKE_CODEX_APP_SERVER = path.resolve(__dirname, '../../fixtures/fake-codex-app-server.mjs');

/** `claude` and `codex` as commands in `dir`, each logging what it was asked: put `dir` on a Host's PATH and the Host finds them. */
export function fakeAgentBins(dir: string, out: { claude?: boolean; codex?: boolean } = {}) {
  const claudeLog = path.join(dir, 'claude.jsonl');
  const codexLog = path.join(dir, 'codex.jsonl');
  const bin = path.join(dir, 'bin');
  nodeCommand(bin, 'claude', FAKE_CLAUDE, { FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_AUTH: out.claude ? 'signed-out' : 'subscription' });
  nodeCommand(bin, 'codex', FAKE_CODEX_APP_SERVER, { FAKE_CODEX_LOG: codexLog, ...(out.codex ? { FAKE_CODEX_LOGIN: 'out' } : {}) });
  return { bin, claudeLog, codexLog };
}

export const tail = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(-1500) : '(none)');
export const logged = (file: string) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

async function horizontalEdges(locator: Locator) {
  const { x, width } = (await locator.boundingBox())!;
  return [x, x + width];
}

/** The question's card, the app's own as on This Mac: `a.ts` picked (and sent when the card asks for it: its Submit button's name carries the shortcut, `Submit ⌘↵`), the card leaves at once and the answers stay in the transcript as the answered-questions record. */
export async function answerTheQuestion(page: Page, agentLog: string, hostLog: string) {
  try {
    const card = page.locator('.question-card');
    await expect(card).toBeVisible({ timeout: 90_000 });
    await expect(card).toContainText('Which files?');
    const composer = page.locator('.thread-composer-area .composer');
    await expect(composer).toBeVisible();
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 682 });
      await expect
        .poll(
          async () => {
            const [questionEdges, composerEdges] = await Promise.all([horizontalEdges(card), horizontalEdges(composer)]);
            return questionEdges.map((edge, i) => edge - composerEdges[i]);
          },
          { message: `Question edges at ${width}px` },
        )
        .toEqual([0, 0]);
    }
    await card.locator('.question-option', { hasText: 'a.ts' }).click();
    const submit = card.getByRole('button', { name: /^Submit\b/ });
    if (await submit.isVisible().catch(() => false)) await submit.click();
  } catch (error) {
    throw new Error(
      `The question did not show: main: ${(await page.getByRole('main').innerText()).slice(0, 700)} / agent: ${tail(agentLog)} / host: ${tail(hostLog)} / ${String(error).slice(0, 160)}`,
    );
  }
  // the card is gone at once, as on This Mac, and what was answered stays in the thread once the machine's Host took it (#4694)
  await expect(page.locator('.question-card')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator('.answered-card').first()).toContainText('a.ts', { timeout: 30_000 });
}

/** J8 on a machine: its agent does not change, and the picker offers the chat's own agent and none of this Mac's. */
export async function pickerOffersOnly(page: Page, own: string, others: RegExp) {
  await page.getByRole('button', { name: 'Select model' }).click();
  await expect(page.getByText(own).first()).toBeVisible();
  await expect(page.getByText(others)).toHaveCount(0);
}
