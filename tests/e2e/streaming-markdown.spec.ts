import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

test('streaming Markdown retains tables, code state and existing words across a pause', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  // Open and paint the chat before the tested reply arrives, so it uses the live
  // arrival path rather than the initial history paint.
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.assistant-message')).toContainText('fake-codex: hello');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('STREAMMARKDOWN SLOW');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const reply = page.locator('.md').filter({ has: page.locator('table') });
  await expect(reply).toContainText('Existing words stay visible');
  const table = await reply.locator('table').elementHandle();
  const link = await reply.locator('a', { hasText: 'the docs' }).elementHandle();
  const code = await reply.locator('.code-block').elementHandle();
  const word = await reply.locator('.fw', { hasText: /^Existing\s*$/ }).elementHandle();
  expect(table && link && code && word).toBeTruthy();

  // Component state must survive text updates too, not just equivalent HTML.
  const wasWrapped = await code!.evaluate((el) => el.classList.contains('wrap'));
  await reply.getByRole('button', { name: 'Toggle wrap' }).click();
  expect(await code!.evaluate((el) => el.classList.contains('wrap'))).toBe(!wasWrapped);

  // Beyond the old 700ms settling timeout: removing word spans here causes a
  // second entrance animation as soon as the stream resumes.
  await page.waitForTimeout(1000);
  expect(await word!.evaluate((el) => el.isConnected)).toBe(true);
  // a word fades as a Web Animation from its moment (src/lib/stepFade.ts); a CSS fade would fire animationstart
  const fadesOf = (el: Element) => el.getAnimations().map((a) => a.startTime);
  const fadesBefore = await word!.evaluate(fadesOf);
  await word!.evaluate((el) => {
    (el as any).replays = 0;
    el.addEventListener('animationstart', () => (el as any).replays++);
  });
  fs.writeFileSync(path.join(harness.dir, 'fake-codex.jsonl.markdown-next'), '');
  await expect(reply).toContainText('when more words arrive.');
  // Wait until the paced reveal has caught up while the fake turn stays open.
  await expect.poll(() => reply.innerText()).toMatch(/(?:when more words arrive\.\s*){80}$/);

  for (const node of [table, link, code, word]) {
    expect(await node!.evaluate((el) => el.isConnected)).toBe(true);
  }
  expect(await code!.evaluate((el) => el.classList.contains('wrap'))).toBe(!wasWrapped);
  expect(await word!.evaluate((el) => (el as any).replays)).toBe(0);
  // no fade started over: the word has no animation it did not have before
  expect((await word!.evaluate(fadesOf)).every((t) => fadesBefore.includes(t))).toBe(true);

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});
