// A chat's history read back (electron/session/peerTranscript.cjs) with images in it: a user's screenshot, a tool's image result, as each harness keeps them. The turn is read as its text, with the image's bytes left out, never as a JSON excerpt of base64.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readPeerTranscript, readPeerReference, withoutInlineMedia } = require('../electron/session/peerTranscript.cjs');

const single = { segments: [{ kind: 'claude', nativeId: 'cl' }] };
const B64 = 'iVBORw0KGgo'.repeat(6000);

/** A turn with a screenshot sent by the user (core/crates/translate/src/claude), and the answer after it. */
const screenshotTurn = {
  id: 't1',
  status: 'completed',
  items: [
    {
      id: 'u',
      type: 'userMessage',
      content: [
        { type: 'image', url: `data:image/png;base64,${B64}` },
        { type: 'text', text: 'What website is shown in the attached screenshot?' },
      ],
    },
    { id: 'a', type: 'agentMessage', text: 'It is example.com, the IANA example domain.' },
  ],
};
/** Tools' image results: an MCP tool's (bare base64 beside its type) and Claude Code's (an API source). */
const toolTurn = {
  id: 't2',
  status: 'completed',
  items: [
    { id: 'm', type: 'mcpToolCall', result: { content: [{ type: 'image', data: B64, mimeType: 'image/png' }] } },
    { id: 'c', type: 'commandExecution', output: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: B64 } }] },
    { id: 'a2', type: 'agentMessage', text: 'The page has a login form.' },
  ],
};

test('a reference to a chat whose turn has a screenshot: the turn as it is, its answer readable, the image left out', async () => {
  const ref = await readPeerReference(single, async () => ({ turns: [screenshotTurn] }));
  assert.equal(ref.earlierContentOmitted, false);
  const [turn] = ref.turns;
  assert.equal(turn.id, 't1');
  assert.equal(turn.items[1].text, 'It is example.com, the IANA example domain.');
  assert.equal(turn.items[0].content[0].url, '[image/png, 64 KB, not included]');
  assert.equal(turn.items[0].content[1].text, 'What website is shown in the attached screenshot?');
  assert.ok(Buffer.byteLength(JSON.stringify(ref)) < 2000);
});

test('tools’ image results, as bare base64 or an API source, are left out the same way, in both readers', async () => {
  const read = async () => ({ turns: [screenshotTurn, toolTurn] });
  const ref = await readPeerReference(single, read);
  assert.deepEqual(
    ref.turns.map((t: any) => t.id),
    ['t1', 't2'],
  );
  const items = ref.turns[1].items;
  assert.equal(items[0].result.content[0].data, '[64 KB, not included]');
  assert.equal(items[0].result.content[0].mimeType, 'image/png');
  assert.equal(items[1].output[0].source.data, '[64 KB, not included]');
  assert.equal(items[2].text, 'The page has a login form.');
  // the read tool's pages: both turns whole within one page, none an excerpt
  const page = await readPeerTranscript(single, {}, read);
  assert.deepEqual(
    page.records.map((r: any) => [r.turn.id, !!r.turn.excerpt]),
    [
      ['t1', false],
      ['t2', false],
    ],
  );
  assert.equal(page.truncated, false);
});

test('text, short values and long text that is not base64 stay as they are', () => {
  const long = 'A long reply. '.repeat(1000);
  const icon = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const turn = {
    id: 'x',
    items: [
      { type: 'agentMessage', text: long },
      { type: 'image', url: icon },
    ],
    n: 3,
    ok: true,
    none: null,
  };
  assert.deepEqual(withoutInlineMedia(turn), turn);
  // bare base64 is an image's only in a data field: elsewhere a long run of letters is text
  assert.equal(withoutInlineMedia({ data: 'QUJD'.repeat(2000) }).data, '[8 KB, not included]');
  assert.equal(withoutInlineMedia({ text: 'QUJD'.repeat(2000) }).text, 'QUJD'.repeat(2000));
  assert.equal(withoutInlineMedia({ data: long }).data, long);
});
