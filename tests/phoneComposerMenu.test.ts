// The phone composer's / and @ menus: what the computer lists and how it is read, the rows that match what is typed, and the text a pick leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../tests/support/phone/register.ts';
const menuPath = '../mobile/src/remote/composerMenu.ts';
const { loadCommands, loadMentions, matchCommands, menusOffered, pickCommand, pickMention, popupAt, MAX_COMMANDS } = await import(menuPath);

const requestOf = (answers: Record<string, unknown>) => {
  const calls: [string, any][] = [];
  const request = async (method: string, params?: any) => {
    calls.push([method, params]);
    const answer = answers[method];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { request: request as any, calls };
};

const command = (name: string, o: object = {}) => ({ name, description: '', hint: '', skill: false, as: 'text', ...o });

test('the / list is read for the chat, each row checked, and a reply that is not a list is refused', async () => {
  const { request, calls } = requestOf({
    'commands.list': {
      commands: [
        { name: 'review', description: 'Review changes', hint: '[focus]', kind: 'command', as: 'text' },
        { name: 'pdf', kind: 'skill', as: 'skill' },
        { name: '' },
        { description: 'no name' },
        null,
        { name: 'odd', kind: 7, as: 'other', description: 4, hint: {} },
      ],
    },
  });
  assert.deepEqual(await loadCommands(request, 'c1'), [
    { name: 'review', description: 'Review changes', hint: '[focus]', skill: false, as: 'text' },
    { name: 'pdf', description: '', hint: '', skill: true, as: 'skill' },
    { name: 'odd', description: '', hint: '', skill: false, as: 'text' },
  ]);
  assert.deepEqual(calls, [['commands.list', { chatId: 'c1' }]]);
  for (const reply of [null, {}, { commands: 'x' }])
    await assert.rejects(loadCommands(requestOf({ 'commands.list': reply }).request, 'c1'), /Could not read the commands/);
});

test('the @ list is chats then files for what is typed, each row checked, and a reply that is not lists is refused', async () => {
  const { request, calls } = requestOf({
    'mentions.list': {
      chats: [{ id: 'c2', title: 'Kyoto trip' }, { id: 'c3' }, null, { title: 'no id' }],
      files: [{ path: 'src/a.ts', name: 'a.ts', directory: false }, { path: 'src', directory: true }, { name: 'no path' }, 3],
    },
  });
  assert.deepEqual(await loadMentions(request, 'c1', 'a'), [
    { kind: 'chat', id: 'c2', title: 'Kyoto trip' },
    { kind: 'file', path: 'src/a.ts', name: 'a.ts', directory: false },
    { kind: 'file', path: 'src', name: 'src', directory: true },
  ]);
  assert.deepEqual(calls, [['mentions.list', { chatId: 'c1', query: 'a' }]]);
  for (const reply of [null, {}, { chats: [] }, { chats: [], files: 'x' }, { chats: 'x', files: [] }])
    await assert.rejects(loadMentions(requestOf({ 'mentions.list': reply }).request, 'c1', ''), /Could not read the mentions/);
});

test('a menu the computer lacks is absent, one it did not say anything about is tried', async () => {
  const hello = (methods: unknown) => requestOf({ 'machine.hello': { capabilities: { methods } } }).request;
  assert.deepEqual(await menusOffered(hello(['chat.send'])), { commands: false, mentions: false });
  assert.deepEqual(await menusOffered(hello(['commands.list'])), { commands: true, mentions: false });
  assert.deepEqual(await menusOffered(hello(['commands.list', 'mentions.list'])), { commands: true, mentions: true });
  assert.deepEqual(await menusOffered(hello(undefined)), { commands: true, mentions: true });
  assert.deepEqual(await menusOffered(requestOf({ 'machine.hello': new Error('offline') }).request), { commands: true, mentions: true });
});

test('commands that start with what is typed come first, then those that hold it, at most eight; after a space or with $ only skills', () => {
  const all = [
    command('compact'),
    command('review'),
    command('pdf', { skill: true }),
    command('code-review', { skill: true }),
    command('preview', { skill: true }),
    ...Array.from({ length: 12 }, (_, i) => command(`r${i}`)),
  ];
  const slash = popupAt('/r', 2, [])!;
  assert.deepEqual(
    matchCommands(all, slash).map((c: any) => c.name),
    ['review', 'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
  );
  assert.equal(matchCommands(all, slash).length, MAX_COMMANDS);
  assert.deepEqual(matchCommands(all, popupAt('/', 1, [])!).length, MAX_COMMANDS, 'a bare / lists the first eight');
  assert.deepEqual(
    matchCommands(all, popupAt('/RE', 3, [])!).map((c: any) => c.name),
    ['review', 'code-review', 'preview'],
    'any case; the name that starts with it first',
  );
  const later = popupAt('look at /re', 11, [])!;
  assert.deepEqual(
    matchCommands(all, later).map((c: any) => c.name),
    ['code-review', 'preview'],
    'after other text only skills, never a plain command',
  );
  assert.deepEqual(
    matchCommands(all, popupAt('$pd', 3, [])!).map((c: any) => c.name),
    ['pdf'],
  );
});

test('the menu opens at a / at the start or after a space, and at an @ after a space; a token or a file already picked does not open it', () => {
  assert.equal(popupAt('hello', 5, []), null);
  assert.deepEqual(popupAt('/re', 3, [])?.kind, 'slash');
  assert.equal(popupAt('a/re', 4, []), null, 'a slash inside a word');
  assert.deepEqual(popupAt('see @src/a', 10, []), { kind: 'mention', query: 'src/a', start: 4 });
  assert.equal(popupAt('mail me@x', 9, []), null, 'an @ inside a word');
  // the caret decides, not the end of the text
  assert.equal(popupAt('/re and more', 12, []), null);
  assert.equal(popupAt('/re and more', 3, [])?.query, 're');
  assert.equal(popupAt('/re', 99, [])?.query, 're', 'a caret past the end is the end');
  // an @ in a chat token's title is not a new mention
  const token = '[Ask @bob](session://claude%3Aabc) ';
  assert.equal(popupAt(`${token}`, token.length, []), null);
  assert.equal(popupAt(`${token}@fi`, token.length + 3, [])?.query, 'fi');
  // a file mention the menu wrote does not reopen it as the caret moves after it
  assert.equal(popupAt('@src/a.ts ', 10, ['@src/a.ts ']), null);
  assert.equal(popupAt('@src/a.ts ', 10, [])?.kind, 'mention');
});

test('a text command leaves /name and a space, a skill beside the message leaves the typed word out; the caret follows', () => {
  const popup = popupAt('/re', 3, [])!;
  assert.deepEqual(pickCommand('/re', popup, 3, command('review')), { text: '/review ', caret: 8, skill: null });
  const mid = popupAt('fix /pd and test', 7, [])!;
  assert.deepEqual(pickCommand('fix /pd and test', mid, 7, command('pdf', { skill: true })), {
    text: 'fix /pdf and test',
    caret: 9,
    skill: null,
  });
  assert.deepEqual(pickCommand('fix /pd and test', mid, 7, command('pdf', { skill: true, as: 'skill' })), {
    text: 'fix  and test',
    caret: 4,
    skill: 'pdf',
  });
  assert.deepEqual(pickCommand('/pd', popupAt('/pd', 3, [])!, 3, command('pdf', { skill: true, as: 'skill' })), {
    text: '',
    caret: 0,
    skill: 'pdf',
  });
  // a space already follows: none is added
  assert.deepEqual(pickCommand('/re rest', popup, 3, command('review')), { text: '/review rest', caret: 8, skill: null });
  assert.deepEqual(pickCommand('/re\nrest', popup, 3, command('review')), { text: '/review \nrest', caret: 8, skill: null });
});

test('a file leaves @path and a space and is remembered; a folder ends in a slash; a chat leaves the app’s link', () => {
  const popup = popupAt('see @sr', 7, [])!;
  assert.deepEqual(pickMention('see @sr', popup, 7, { kind: 'file', path: 'src/a.ts', name: 'a.ts', directory: false }), {
    text: 'see @src/a.ts ',
    caret: 14,
    applied: '@src/a.ts ',
  });
  assert.deepEqual(pickMention('see @sr', popup, 7, { kind: 'file', path: 'src', name: 'src', directory: true }), {
    text: 'see @src/ ',
    caret: 10,
    applied: '@src/ ',
  });
  const chat = pickMention('see @ky', popupAt('see @ky', 7, [])!, 7, { kind: 'chat', id: 'claude:abc', title: 'Kyoto [trip]' });
  assert.equal(chat.text, 'see [Kyoto \\[trip\\]](session://claude%3Aabc) ');
  assert.equal(chat.caret, chat.text.length);
  assert.equal(chat.applied, null);
  // text after the caret stays after the pick
  assert.deepEqual(pickMention('@sr more', popupAt('@sr more', 3, [])!, 3, { kind: 'file', path: 'a', name: 'a', directory: false }), {
    text: '@a more',
    caret: 3,
    applied: '@a ',
  });
});

test('a pick before a line break leaves the same text as one before a space, which does not open the menu again', () => {
  const popup = popupAt('see @pr\nthen fix', 7, [])!;
  const picked = pickMention('see @pr\nthen fix', popup, 7, { kind: 'file', path: 'src/price.ts', name: 'price.ts', directory: false });
  assert.equal(picked.text, 'see @src/price.ts \nthen fix');
  assert.equal(popupAt(picked.text, picked.caret, [picked.applied!]), null);
  assert.equal(popupAt(picked.text, picked.caret, [])?.kind, 'mention', 'it would, if the pick were not remembered');
});
