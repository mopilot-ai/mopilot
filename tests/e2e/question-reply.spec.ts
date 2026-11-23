import { test, expect } from './fixtures/app';

const single =
  '<send_user_message_question_reply>\n' +
  JSON.stringify([{ questionItemId: 'internal-id', question: '请选择日期？', answer: '周六。\n上午十点。' }]) +
  '\n</send_user_message_question_reply>';
const multiple =
  '<send_user_message_question_reply>' +
  JSON.stringify([
    { question: 'Which day?', answer: 'Saturday' },
    { question: 'Which time?', answer: '10:00' },
  ]) +
  '</send_user_message_question_reply>';
const malformed = '<send_user_message_question_reply>{broken}</send_user_message_question_reply>';

test.use({
  seed: { codexThreads: [{ id: 'question-reply-history', name: 'Question reply history', turns: [single, multiple, malformed, single] }] },
});

test('historical replies render, survive reopening, copy and edit as readable text', async ({ page, harness }) => {
  await page.getByRole('complementary').getByText('Question reply history', { exact: true }).click();
  const messages = page.locator('.user-message');
  await expect(messages).toHaveCount(4);
  await expect(messages.nth(0).locator('.question-reply-summary')).toHaveText('请选择日期？');
  await expect(messages.nth(0).locator('.user-bubble')).toHaveText('请选择日期？周六。\n上午十点。');
  await expect(messages.nth(0)).not.toContainText('internal-id');
  await expect(messages.nth(0)).not.toContainText('send_user_message_question_reply');
  await expect(messages.nth(1).locator('.user-bubble')).toHaveText('Which day?\nSaturday\n\nWhich time?\n10:00');
  await expect(messages.nth(2).locator('.user-bubble')).toHaveText(malformed);

  await messages.nth(1).hover();
  await messages.nth(1).getByRole('button').first().click();
  await expect.poll(() => harness.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Which day?\nSaturday\n\nWhich time?\n10:00');

  await harness.quit();
  await harness.relaunch();
  const reopened = harness.page;
  await reopened.getByRole('complementary').getByText('Question reply history', { exact: true }).click();
  await expect(reopened.locator('.user-message').first().locator('.user-bubble')).toHaveText('请选择日期？周六。\n上午十点。');
  // Editing is available only for the last turn, as in the ordinary chat CUJ.
  await reopened.locator('.user-message').last().hover();
  await reopened.locator('.user-message').last().getByRole('button', { name: 'Edit message' }).click();
  // the composer is an editable text surface: its text keeps the line break
  await expect(reopened.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(/^周六。\n上午十点。$/);
});
