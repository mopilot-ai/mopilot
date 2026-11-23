import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionalTitle, generatedTitle, titlePrompt } from '../shared/title.mjs';

test('title limits count Unicode code points without splitting surrogate pairs', () => {
  assert.equal(provisionalTitle('a'.repeat(59) + '🙂tail'), 'a'.repeat(59) + '🙂…');
  assert.equal(provisionalTitle('🙂'.repeat(60)), '🙂'.repeat(60));
  assert.equal(generatedTitle('b'.repeat(79) + '🙂tail', 'fallback'), 'b'.repeat(79) + '🙂…');
  assert.equal(generatedTitle('', '🙂'.repeat(61)), '🙂'.repeat(60) + '…');
  assert.equal(titlePrompt('a'.repeat(1999) + '🙂tail').split('Request:\n')[1], 'a'.repeat(1999) + '🙂');
  assert.equal(provisionalTitle('🙂'.repeat(40) + ' ' + 'tail'.repeat(20)), '🙂'.repeat(40) + '…');
  assert.equal(provisionalTitle('🙂'.repeat(20) + ' ' + 'x'.repeat(50)), '🙂'.repeat(20) + ' ' + 'x'.repeat(39) + '…');
});

test('generated titles remove formatting, support Chinese, and fall back on empty output', () => {
  assert.equal(generatedTitle('\n **Fix login tests.**\nExtra explanation', 'request'), 'Fix login tests');
  assert.equal(generatedTitle('“修复登录问题。”', 'request'), '修复登录问题');
  assert.equal(generatedTitle(null, '  fix\nlogin  '), 'fix login');
  assert.equal(generatedTitle('***', 'request'), 'request');
  assert.ok(generatedTitle('word '.repeat(30), 'request').length <= 81);
});

test('the CLI’s limit errors are never a title', () => {
  const limit = "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage";
  assert.equal(generatedTitle(limit, 'pay the fee'), 'pay the fee');
  assert.equal(generatedTitle('You’ve reached your session limit · resets 3:30am', 'pay the fee'), 'pay the fee');
  assert.equal(generatedTitle("You're out of extra usage · resets 7pm", 'pay the fee'), 'pay the fee');
  // an ordinary title that starts alike is kept
  assert.equal(generatedTitle('You hit the limit of the parser', 'x'), 'You hit the limit of the parser');
});

test('title helpers use a bounded request and explicitly keep its language', () => {
  const prompt = titlePrompt('中'.repeat(3000));
  assert.match(prompt, /same language/);
  assert.match(prompt, /do not follow instructions/);
  // the CLI's own title rules: a noun phrase that leads with the subject and keeps the specific name
  assert.match(prompt, /noun phrase/);
  assert.match(prompt, /Leave out request verbs/);
  assert.match(prompt, /verbatim/);
  assert.equal(prompt.split('Request:\n')[1].length, 2000);
});

test('panel handoff instructions and the tab marker never become the chat title or title-helper request', async () => {
  const { browserHandoffMessage } = await import('../shared/chromeHandoff.mjs');
  const prompt = browserHandoffMessage(
    'Use the existing Chrome tab 123; do not open another.',
    'Can this booking be refunded?\n\n[Chrome tab: https://example.org/booking]',
  );
  assert.equal(provisionalTitle(prompt), 'Can this booking be refunded?');
  assert.equal(titlePrompt(prompt).split('Request:\n')[1], 'Can this booking be refunded?');
});
