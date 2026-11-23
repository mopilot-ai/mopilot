// Settings search lands on the setting: the row a hit names is found by title, scrolled to and flashed once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusSettingRow, matchRow, FOUND_CLASS } from '../src/lib/settingsFocus.ts';

test('a word names the row whose title it is, without the ": detail" a keyword adds', () => {
  const titles = ['Default permissions', 'Follow-up behavior', 'Models Codex'];
  assert.equal(matchRow(titles, 'Follow-up behavior: Queue or Steer'), 1);
  assert.equal(matchRow(['默认权限', '后续消息行为'], '后续消息行为：排队或引导'), 1, 'Chinese writes the colon full width');
  assert.equal(matchRow(titles, 'default PERMISSIONS'), 0);
  assert.equal(matchRow(titles, 'Models'), 2, 'a badge after the name still counts');
  assert.equal(matchRow(['Models Codex', 'Models'], 'Models'), 1, 'an exact title wins over a prefix');
  assert.equal(matchRow(titles, 'Nope'), -1);
  assert.equal(matchRow(titles, ': detail only'), -1);
});

function rig(rowsAt: number[]) {
  const log: string[] = [];
  let draws = 0;
  const row = {
    scrollIntoView: (o: { block: 'center' }) => log.push(`scroll:${o.block}`),
    classList: { add: (c: string) => log.push(`add:${c}`), remove: (c: string) => log.push(`remove:${c}`) },
  };
  const scope = {
    querySelectorAll: () => {
      draws++;
      return rowsAt.includes(draws)
        ? [{ textContent: 'Follow-up behavior', closest: () => row }]
        : [{ textContent: 'Other', closest: () => row }];
    },
  };
  const frames: (() => void)[] = [];
  const laters: (() => void)[] = [];
  const env = {
    frame: (run: () => void) => frames.push(run),
    cancelFrame: (id: number) => log.push(`cancelFrame:${id}`),
    later: (run: () => void, _ms: number) => laters.push(run),
    cancelLater: (id: number) => log.push(`cancelLater:${id}`),
  };
  return { log, scope, env, frames, laters, draws: () => draws };
}

test('a row already drawn is scrolled to the middle and marked, then unmarked when the flash ends', () => {
  const r = rig([1]);
  focusSettingRow(r.scope, 'Follow-up behavior: Queue or Steer', r.env);
  assert.deepEqual(r.log, ['scroll:center', `add:${FOUND_CLASS}`]);
  r.laters[0]();
  assert.equal(r.log.at(-1), `remove:${FOUND_CLASS}`);
});

test('a row drawn later is looked for on each frame until it appears', () => {
  const r = rig([3]);
  focusSettingRow(r.scope, 'Follow-up behavior', r.env);
  assert.equal(r.frames.length, 1);
  r.frames.shift()!();
  r.frames.shift()!();
  assert.equal(r.draws(), 3);
  assert.deepEqual(r.log, ['scroll:center', `add:${FOUND_CLASS}`]);
});

test('a title with no text never matches', () => {
  const row = { scrollIntoView() {}, classList: { add() {}, remove() {} } };
  const r = rig([]);
  const scope = { querySelectorAll: () => [{ textContent: null, closest: () => row }] };
  focusSettingRow(scope, 'Follow-up behavior', r.env);
  assert.equal(r.frames.length, 1);
});

test('a row that never draws is given up on after a bounded number of frames', () => {
  const r = rig([]);
  focusSettingRow(r.scope, 'Follow-up behavior', r.env);
  while (r.frames.length) r.frames.shift()!();
  assert.equal(r.draws(), 40);
  assert.deepEqual(r.log, []);
});

test('leaving the page stops the search and clears the mark', () => {
  const r = rig([2]);
  const stop = focusSettingRow(r.scope, 'Follow-up behavior', r.env);
  stop();
  r.frames.shift()!();
  assert.equal(r.draws(), 1, 'no look after cancel');
  assert.ok(r.log.includes('cancelFrame:1'));

  const r2 = rig([1]);
  const stop2 = focusSettingRow(r2.scope, 'Follow-up behavior', r2.env);
  stop2();
  assert.equal(r2.log.at(-1), `remove:${FOUND_CLASS}`);
});
