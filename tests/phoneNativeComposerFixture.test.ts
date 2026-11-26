// Native acceptance boundaries satisfy production client parsers before an isolated Xcode build is dispatched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/phone/register.ts';
import { runtime, media } from './e2e/fixtures/phone-composer-native-fixture';
const clientPath = '../mobile/src/remote/client';
const menuPath = '../mobile/src/remote/composerMenu';
const { loadStart, loadOptions, startChat, ownedRequest } = await import(clientPath);
const { loadCommands, loadMentions, menusOffered } = await import(menuPath);

test('native fixture exposes valid pre-chat scopes, scrollable menus and a skill accepted through chat.start', async () => {
  const request = ownedRequest(runtime);
  const start = await loadStart(request);
  assert.deepEqual(
    start.harnesses.map((h: any) => h.id),
    ['claude', 'codex'],
  );
  const options = await loadOptions(request, 'codex', start.caps.ceiling);
  assert.equal(options.models[0].id, 'native-model');
  const scope = { harness: 'claude', projectId: 'native' };
  assert.deepEqual(await menusOffered(request, scope), { commands: true, mentions: true });
  assert.equal((await loadCommands(request, scope)).length, 8);
  const files = (await loadMentions(request, scope, '')).filter((r: any) => r.kind === 'file');
  assert.equal(files.length, 12);
  assert.equal(files.at(-1).path, 'src/file11.ts');
  assert.deepEqual(await loadMentions(request, { ...scope, projectId: null }, ''), []);
  await assert.rejects(loadMentions(request, 'not-a-chat', ''), /Follow an existing chat/);
  const skills = await loadCommands(request, { harness: 'codex', projectId: 'native' });
  assert.deepEqual(
    skills.map((r: any) => [r.name, r.as, r.skill]),
    [['native-skill', 'skill', true]],
  );
  const { chatId } = await startChat(request, {
    harness: 'codex',
    projectId: 'native',
    text: 'native prompt',
    model: 'native-model',
    effort: null,
    permission: 'default',
    account: null,
    worktree: false,
    startId: 'native-check',
    attachments: [],
    skills: ['native-skill'],
  });
  const followed = await request('chat.follow', { chatId });
  assert.equal(followed.items[0].text, 'Native start accepted: native-skill; native prompt');
});

test('native fixture supplies a decodable picture and ordered upload acknowledgments', async () => {
  const [file] = (await media.library(10)).picked;
  const png = Buffer.from(file.base64, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [128, 64]);
  const part = await runtime.request('chat.attach', { stream: 's', index: 0, total: 2, name: file.name });
  assert.deepEqual(part, { stream: 's', received: 1, done: false });
  const done = await runtime.request('chat.attach', { stream: 's', index: 1, total: 2, name: file.name });
  assert.equal(done.done, true);
  assert.equal(done.id, '0123456789abcdef');
});
