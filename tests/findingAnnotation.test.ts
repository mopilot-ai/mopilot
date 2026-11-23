// A review finding's card under its line in the Changes pane: a finding with no line has no line label, and its Next names none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { render, settle } from './support/thread-kit.ts';

const { FindingAnnotation, lineLabel } = await import('../src/components/panels/FindingAnnotation.tsx');

test('a finding with no line: no line label, and Next says so plainly; a range reads as Lines', async () => {
  const calls: string[] = [];
  const v = await render(
    h(FindingAnnotation, {
      reviewId: 'r1',
      index: 0,
      finding: { file: 'a.ts', line: null, summary: 's' },
      status: 'open',
      current: false,
      author: 'Kimi Code',
      harness: null,
      onNext: () => calls.push('next'),
      onDismiss: () => calls.push('dismiss'),
      onFix: () => calls.push('fix'),
    }),
  );
  assert.equal(v.$('.finding-annotation-lines'), null);
  assert.equal(v.$('.finding-annotation-author')?.textContent, 'Kimi Code');
  assert.equal(v.$('.finding-annotation')?.className, 'finding-annotation');
  await settle(() => (v.$('[aria-label="Next finding"]') as HTMLElement).click());
  assert.deepEqual(calls, ['next']);
  assert.equal(lineLabel(4, 6), 'Lines 4–6');
  assert.equal(lineLabel(4, 4), 'Line 4');
  await v.unmount();
});
