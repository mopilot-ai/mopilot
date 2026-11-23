// Which chats a machine page lists (#4603): this machine's, newest first, at most twenty, whatever the Mac's list holds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/phone/register.ts';

const path = '../mobile/src/components/MachineChats';
const { chatsOn, MACHINE_CHATS_SHOWN } = await import(path);

test('no list, or a list with none of this machine’s chats, is nothing', () => {
  assert.deepEqual(chatsOn(null, 'h1'), []);
  assert.deepEqual(chatsOn(undefined, 'h1'), []);
  assert.deepEqual(chatsOn([{ id: 'a', hostId: 'h2', at: 1 }], 'h1'), []);
});

test('newest first, a chat the Mac gave no time last, and only the newest twenty', () => {
  const rows = [
    { id: 'none', hostId: 'h1' },
    { id: 'old', hostId: 'h1', at: 1 },
    { id: 'new', hostId: 'h1', at: 9 },
    { id: 'also-none', hostId: 'h1' },
  ];
  assert.deepEqual(
    chatsOn(rows, 'h1').map((c: any) => c.id),
    ['new', 'old', 'none', 'also-none'],
  );
  const many = Array.from({ length: MACHINE_CHATS_SHOWN + 5 }, (_, i) => ({ id: `c${i}`, hostId: 'h1', at: i }));
  const shown = chatsOn(many, 'h1');
  assert.equal(shown.length, MACHINE_CHATS_SHOWN);
  assert.equal(shown[0].id, `c${MACHINE_CHATS_SHOWN + 4}`);
});

test('the chats this phone started count too, except one the Mac lists, and also when the Mac lists none', () => {
  const started = [
    { chatId: 's1', machineId: 'h1', title: 'Mine', at: 5 },
    { chatId: 'listed', machineId: 'h1', title: 'Mine too', at: 6 },
    { chatId: 's2', machineId: 'h2', title: 'Elsewhere', at: 7 },
  ];
  assert.deepEqual(
    chatsOn([{ id: 'listed', title: 'Theirs', hostId: 'h1', at: 1 }], 'h1', started).map((c: any) => [c.id, c.title]),
    [
      ['s1', 'Mine'],
      ['listed', 'Theirs'],
    ],
  );
  assert.deepEqual(
    chatsOn(null, 'h1', started).map((c: any) => c.id),
    ['listed', 's1'],
  );
});
