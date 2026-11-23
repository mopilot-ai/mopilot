// What a file or folder attached to a machine chat becomes in each harness's turn input (#5145): the Host's copy of it is named in the input the agent reads, whichever agent the chat runs, and the Mac's own path never is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHostImages } from '../host/src/chatImages.mjs';
const require = createRequire(import.meta.url);
const { uploadFiles } = require('../electron/host/fileTransfer.cjs');
const { buildInput, turnParams } = require('../electron/harness/codexParams.cjs');
const { buildClaudeMessage } = require('../electron/harness/claude/message.cjs');
const { acpBlocks } = require('../electron/harness/acp/blocks.cjs');
const { userInput } = require('../shared/userInput.mjs');
const { parseUserText } = require('../shared/userText.mjs');

/** A note and a folder uploaded the way the app sends them, kept by the Host, with the source removed so no agent finds it on the Mac side. */
async function hosted(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-files-input-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createHostImages({ dir: path.join(dir, 'private', 'images') });
  const host: any = { speaks: () => true, call: async (_m: string, p: any) => ({ result: await store.upload({ ...p, owner: 'pair-a' }) }) };
  const note = path.join(dir, 'src', 'note-secret.txt');
  const folder = path.join(dir, 'src', 'proj');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(note, 'the secret word is plum');
  fs.writeFileSync(path.join(folder, 'a.txt'), 'alpha');
  const refs = await uploadFiles({
    host,
    chatId: 'chat-a',
    epoch: 1,
    attachments: [
      { kind: 'file', path: note },
      { kind: 'file', path: folder },
    ],
    check: () => undefined,
  });
  fs.rmSync(path.join(dir, 'src'), { recursive: true });
  // the Host marks what it staged (host/src/chatEffects.mjs)
  const attachments = (await store.files('pair-a', 'chat-a', 'key-1', refs, () => undefined)).map((f: any) => ({ ...f, staged: true }));
  return { dir, attachments, source: path.join(dir, 'src') };
}

test('Codex: the text file and the folder a machine chat carries are named in the turn input by their Host paths, in a hidden block', async (t) => {
  const { attachments, source } = await hosted(t);
  const input = buildInput('read them', attachments);
  const text = input.find((i: any) => i.type === 'text').text;
  assert.equal(text, `<sage-attached-files>\n${attachments.map((a: any) => `@${a.path}`).join('\n')}\n</sage-attached-files>\nread them`);
  assert(!JSON.stringify(input).includes(source), 'the Mac-side source never travels');
  assert(fs.readFileSync(attachments[0].path, 'utf8').includes('plum'), 'what the input names is there to read');
  // what the thread shows of that text is only what was typed
  assert.equal(parseUserText(text).text, 'read them');
  // and the turn Codex is started with carries the same input
  const params = turnParams('thread', 'c1', { text: 'read them', attachments, opts: {} }, {}, '/work');
  assert.equal(params.input.find((i: any) => i.type === 'text').text, text);
});

test('Codex: a staged file with no typed text still has text naming it, and a staged file with no path names nothing', () => {
  const only = buildInput('', [{ kind: 'file', name: 'n.txt', path: '/h/n.txt', staged: true }]);
  assert.deepEqual(only, [
    { type: 'text', text: '<sage-attached-files>\n@/h/n.txt\n</sage-attached-files>\n', text_elements: [] },
    { type: 'mention', name: 'n.txt', path: '/h/n.txt' },
  ]);
  assert.equal(parseUserText(only[0].text).text, '');
  assert.equal(buildInput('hi', [{ kind: 'file', name: 'n.txt', staged: true }])[0].text, 'hi');
});

test('Codex: This Mac’s own file and folder attachments give the same input as before, paths with spaces and text naming them included', () => {
  const local = [
    { kind: 'file', name: 'my notes.txt', path: '/Users/me/My Docs/my notes.txt' },
    { kind: 'file', name: 'proj dir', path: '/Users/me/proj dir' },
  ];
  for (const text of ['read them', '', 'see @/Users/me/My Docs/my notes.txt', 'see @/Users/me/proj dir please']) {
    // what main built before this change: the shared user input, nothing added
    assert.deepEqual(buildInput(text, local), userInput(text, local, { tabsFor: 'codex-browser-plugin' }));
  }
  assert.deepEqual(buildInput('read them', local), [
    { type: 'text', text: 'read them', text_elements: [] },
    { type: 'mention', name: 'my notes.txt', path: '/Users/me/My Docs/my notes.txt' },
    { type: 'mention', name: 'proj dir', path: '/Users/me/proj dir' },
  ]);
});

test('Claude Code: the files a machine chat carries are named in the message by their Host paths', async (t) => {
  const { attachments, source } = await hosted(t);
  const message = buildClaudeMessage({ text: 'read them', attachments }, () => null);
  const text = typeof message.content === 'string' ? message.content : message.content.map((c: any) => c.text ?? '').join('\n');
  for (const a of attachments) assert(text.includes(`@${a.path}`), `the message does not name ${a.path}`);
  assert(!text.includes(source));
});

test('ACP: the files a machine chat carries are resource links to their Host paths', async (t) => {
  const { attachments, source } = await hosted(t);
  const blocks = await acpBlocks('read them', attachments, async () => null);
  const links = blocks.filter((b: any) => b.type === 'resource_link');
  assert.deepEqual(
    links.map((b: any) => b.uri),
    attachments.map((a: any) => `file://${a.path}`),
  );
  assert(!JSON.stringify(blocks).includes(source));
});
