// MoMo's answer chips (alignment row 6, shared/momoOptions.mjs): the Options line is read the same on every harness, only a valid one becomes chips and leaves the text, MoMo's turn is told about it, only MoMo's chats have it, and its CSS takes its motion from the shared tokens and stands still with Reduce Motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { readOptions, OPTIONS_NOTE, MAX_LABEL } from '../shared/momoOptions.mjs';
import { momoBlock } from '../shared/momoContext.mjs';
import { presentItems } from '../src/harness/codexTranslate.ts';

test('a reply’s last line "Options: A | B | C" is the chips and leaves the text', () => {
  assert.deepEqual(readOptions('Move your 3 pm?\nOptions: Yes | No | Not now\n'), {
    text: 'Move your 3 pm?',
    options: ['Yes', 'No', 'Not now'],
  });
  assert.deepEqual(readOptions('One.\n\nTwo?\n  Options:A|B  '), { text: 'One.\n\nTwo?', options: ['A', 'B'] });
  assert.deepEqual(readOptions('Pick?\nOptions: a | b | c | d'), { text: 'Pick?', options: ['a', 'b', 'c', 'd'] });
});

test('anything else stays text as written: no guessed chips, no hidden words', () => {
  const same = (t: unknown) => assert.deepEqual(readOptions(t), { text: typeof t === 'string' ? t : '', options: [] });
  same('Plain reply?');
  same('');
  same(undefined);
  same(7);
  same('Options: Yes | No'); // only the line
  same('Hm?\nOptions: Yes'); // one answer
  same('Hm?\nOptions: a | b | c | d | e'); // five
  same('Hm?\nOptions: a | | b'); // an empty label
  same('Hm?\nOptions: a | A'); // a repeat
  same(`Hm?\nOptions: a | ${'x'.repeat(MAX_LABEL + 1)}`);
  same('Hm?\nOptions:'); // nothing after it
  same('Options: a | b\nHm?'); // not the last line
  assert.equal(readOptions(`Hm?\nOptions: a | ${'x'.repeat(MAX_LABEL)}`).options.length, 2);
});

test('only MoMo’s thread takes the line out of a reply and keeps the labels on the item', () => {
  const item = { id: 'a', type: 'agentMessage', text: 'Ok?\nOptions: Yes | No' };
  assert.deepEqual(presentItems([item])[0], item);
  assert.deepEqual(presentItems([item], true)[0], { id: 'a', type: 'agentMessage', text: 'Ok?', options: ['Yes', 'No'] });
  const plain = { id: 'b', type: 'agentMessage', text: 'Ok?' };
  const user = { id: 'u', type: 'userMessage', text: 'Options: a | b' };
  assert.deepEqual(presentItems([plain, user], true), [plain, user]);
});

test('MoMo’s turn is told about the line, on every harness, as part of who it is', () => {
  const block = momoBlock({ name: 'MoMo' }) as string;
  assert.ok(block.includes(OPTIONS_NOTE));
  assert.match(OPTIONS_NOTE, /Options: A \| B \| C/);
  assert.equal(momoBlock({ facts: ['x'] })!.includes(OPTIONS_NOTE), false, 'no name, no identity');
});

test('the chips enter on the design’s chip beat from the shared tokens and stand still with Reduce Motion', () => {
  const root = postcss.parse(readFileSync(new URL('../src/components/momo/momoOptions.module.css', import.meta.url), 'utf8'));
  // The design's spacing: 16 pt bubble to pills, 28 pt pills, 12 pt between them
  const size: Record<string, string> = {};
  root.walkRules(/^\.(chips|chip)$/, (r) =>
    r.walkDecls(/^(gap|margin-top|height)$/, (d) => void (size[`${r.selector}${d.prop}`] = d.value)),
  );
  assert.deepEqual(size, { '.chipsgap': '12px', '.chipsmargin-top': '16px', '.chipheight': '28px' });
  const motion: string[] = [];
  root.walkDecls(/^(animation|transition)/, (d) => void motion.push(`${d.prop}: ${d.value}`));
  const joined = motion.join('\n');
  assert.match(joined, /animation: chipIn var\(--momo-dur-m, 200ms\) var\(--momo-ease-overshoot, ease-out\) backwards/);
  assert.match(joined, /animation-delay: calc\(var\(--i, 0\) \* var\(--momo-dur-xs, 60ms\)\)/);
  assert.match(joined, /var\(--momo-dur-xs, 60ms\) var\(--momo-ease-out, ease-out\)/);
  let from = '';
  root.walkAtRules('keyframes', (k) => void (from = k.toString()));
  assert.match(from, /translateY\(10px\) scale\(0\.7\)/);
  const still: string[] = [];
  root.walkAtRules('media', (m) => {
    if (m.params.includes('prefers-reduced-motion')) m.walkDecls((d) => void still.push(`${d.prop}: ${d.value}`));
  });
  assert.deepEqual(still, ['animation: none', 'transition: none']);
});
