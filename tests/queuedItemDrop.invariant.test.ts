// A queued side-session item must not leave a chat's queue unrecorded: code that drops entries from the journal's queue
// settles them for their sender through userRemoval.cjs (queueDropped / queuedRemoved), so a new drop path cannot lose a message silently (#3200).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

export const GUARDS = ['electron/session/orchestration/'];

const dir = new URL('../electron/session/orchestration/', import.meta.url);
const read = (file: string) => fs.readFileSync(new URL(file, dir), 'utf8');

test('every file that drops entries from the journal queue settles them through userRemoval.cjs', () => {
  const droppers = fs.readdirSync(dir).filter((f) => f.endsWith('.cjs') && /\.queue = [\w.]*queue\.filter\(/.test(read(f)));
  assert.ok(droppers.includes('scheduler.cjs') && droppers.includes('forget.cjs'), 'the scan finds the drop paths');
  for (const file of droppers) {
    // forget.cjs runs inside a journal write; its caller records the items first (service.cjs chatDeleted)
    const settles = file === 'forget.cjs' ? read('service.cjs') : read(file);
    assert.match(settles, /queueDropped\(|queuedRemoved\(/, `${file} drops queued items without recording them`);
    assert.match(settles, /require\('\.\/userRemoval\.cjs'\)/, `${file} does not use the shared helper`);
  }
});

test('the deletion hook records a chat’s queued items before the journal forgets the chat', () => {
  const src = read('service.cjs');
  const hook = src.slice(src.indexOf('chatDeleted(chatId) {'));
  assert.ok(
    hook.indexOf('queueDropped(this, chatId') > 0 && hook.indexOf('queueDropped(this, chatId') < hook.indexOf('forgetDeleted(this)'),
  );
});
