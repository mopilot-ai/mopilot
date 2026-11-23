// The shared main / "more" grouping of a harness's model list (picker and Settings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupModels } from '../src/harness/modelGroups.ts';

const m = (id: string, more?: boolean) => ({ id, label: id, efforts: [], defaultEffort: null, fast: false, ...(more ? { more } : {}) });

test('groupModels: main models then pinned versions, each in the harness order', () => {
  const { main, more } = groupModels([m('opus'), m('opus-4', true), m('fable'), m('sonnet-4', true), m('haiku')]);
  assert.deepEqual(
    main.map((x) => x.id),
    ['opus', 'fable', 'haiku'],
  );
  assert.deepEqual(
    more.map((x) => x.id),
    ['opus-4', 'sonnet-4'],
  );
});

test('groupModels: no versions to hide, and an empty list', () => {
  assert.deepEqual(groupModels([m('gpt-6.1-sol'), m('gpt-6-luna')]).more, []);
  assert.deepEqual(groupModels([]), { main: [], more: [] });
});
