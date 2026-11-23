import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SummarySlot } from '../src/components/panels/SummarySlot.ts';

const slot = (routeName: any, summaryOpen = true, diffOpen = false) =>
  renderToStaticMarkup(h(SummarySlot, { routeName, summaryOpen, diffOpen }, h('i', null, 'summary')));

test('the summary slot holds the summary in a chat and is absent on home', () => {
  assert.equal(slot('home'), '');
  assert.equal(slot('thread'), '<div class="summary-slot"><i>summary</i></div>');
});

test('the summary slot is absent when closed, beside the diff, or on other pages', () => {
  assert.equal(slot('thread', false), '');
  assert.equal(slot('thread', true, true), '');
  assert.equal(slot('settings'), '');
});
