// The block a spec writes into the user's ssh files is one block, replaced in place, and nothing else of the file is touched (tests/e2e/fixtures/markedBlock.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMarkedBlock } from './e2e/fixtures/markedBlock.ts';

const TAG = 'mopilot-e2e ssh-to-self';
const USER = 'Host work\n  User me\n\nHost *\n  ServerAliveInterval 30\n';

test("a file with the user's own lines keeps them, and gets the block once at its end", () => {
  const out = withMarkedBlock(USER, TAG, 'Host localhost\n  IdentityFile /k1\n');
  assert.ok(out.startsWith(USER.trimEnd()));
  assert.equal(out.split(`# ${TAG} begin`).length - 1, 1);
  assert.ok(out.endsWith(`# ${TAG} end\n`));
});

test("written again, the block is replaced: no growth, the new body, the user's lines unchanged", () => {
  let text = USER;
  for (const n of [1, 2, 3, 4]) text = withMarkedBlock(text, TAG, `Host localhost\n  IdentityFile /k${n}\n`);
  assert.equal(text.split('Host localhost').length - 1, 1);
  assert.ok(text.includes('/k4') && !text.includes('/k3'));
  assert.ok(text.startsWith(USER.trimEnd()));
});

test('an empty file gets just the block; several stale copies are all replaced', () => {
  assert.equal(withMarkedBlock('', TAG, 'a\n'), `# ${TAG} begin\na\n# ${TAG} end\n`);
  const stale = `x\n# ${TAG} begin\nold1\n# ${TAG} end\nmid\n# ${TAG} begin\nold2\n# ${TAG} end\n`;
  assert.equal(withMarkedBlock(stale, TAG, 'new\n'), `x\nmid\n\n# ${TAG} begin\nnew\n# ${TAG} end\n`);
});

test("a begin line with no end is not cut away: what follows it is the user's", () => {
  const out = withMarkedBlock(`a\n# ${TAG} begin\nuser line\n`, TAG, 'new\n');
  assert.ok(out.includes('user line'));
  assert.ok(out.endsWith(`# ${TAG} end\n`));
});

test("another tag's block is left alone", () => {
  const other = '# other begin\nkeep\n# other end\n';
  assert.ok(withMarkedBlock(other, TAG, 'b\n').includes(other.trimEnd()));
});
