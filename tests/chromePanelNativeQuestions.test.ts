// Native ACP question producers retain precise constraints, current-source ownership and terminal delivery failures in the panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PanelQuestions } = require('../electron/capabilities/browser/chromePanelQuestions.cjs');
const { AcpQuestions } = require('../electron/harness/acp/questions.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
function fixture() {
  const state = new SessionStore();
  const record = { id: 'chat', segments: [{ kind: 'acp:gemini', nativeId: 'native' }], meta: {} };
  const controller = new ChatController({
    state,
    chats: { record: () => record, records: new Map([['chat', record]]) },
    codex: {},
    claudeTurns: {},
    acpTurns: {},
  });
  const agent = {};
  const chat = { chatId: 'chat', key: controller.ref('chat').key, harness: 'gemini', agent };
  const host: any = {
    chats: new Map([[chat.key, chat]]),
    chatOf: () => chat,
    label: () => 'Gemini',
    emitEvent: (e: any) => controller.onAcpEvent(e),
  };
  const native = new AcpQuestions(host);
  host.questions = native;
  controller.acp = host;
  let response: any = { status: 'delivered' };
  const sent: any[] = [];
  const schema = {
    type: 'object',
    required: ['places'],
    properties: {
      places: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 2 },
      name: { type: 'string', minLength: 1, maxLength: 30 },
      count: { type: 'integer', minimum: 1, maximum: 5 },
      optional: { type: 'boolean' },
    },
  };
  const open = () =>
    native.open(
      agent,
      { mode: 'form', sessionId: 'native', message: 'Choose', requestedSchema: schema },
      {
        defer: () => null,
        respond: (p: any) => {
          sent.push(p);
          return response;
        },
      },
    );
  const panel = new PanelQuestions({ controller, acpHost: host }, { reachable: () => true, agent: () => 'Gemini' });
  return {
    panel,
    native,
    controller,
    state,
    record,
    chat,
    host,
    sent,
    open,
    response: (r: any) => {
      response = r;
    },
  };
}

test('the panel reconstructs native array and length constraints and keeps terminal native failures disabled', async () => {
  const f = fixture();
  f.open();
  const first = f.panel.read('chat', [{ items: undefined }])[0];
  assert.equal(first.schema.properties.places.minItems, 1);
  assert.deepEqual(first.schema.properties.places.items.enum, ['a', 'b']);
  assert.equal(first.schema.properties.name.maxLength, 30);
  assert.equal(first.schema.properties.optional.minimum, undefined);
  assert.equal(await f.panel.answer('chat', first.id, 'constructor', {}, first.version), false);
  assert.equal(await f.panel.answer('chat', first.id, 'submit', {}, 'old-version'), false);
  f.response({ status: 'failed', error: 'Native connection closed' });
  await assert.rejects(f.panel.answer('chat', first.id, 'submit', { places: ['a'] }, first.version), /Native connection closed/);
  const terminal = f.panel.read('chat', [])[0];
  assert.equal(terminal.disabled, true);
  assert.match(terminal.detail, /Native connection closed/);
  assert.equal(await f.panel.answer('chat', first.id, 'decline', undefined, first.version), false);
});

test('read and answer both retire the old ACP source, and unavailable native owners cannot accept a control', async () => {
  for (const onRead of [true, false]) {
    const f = fixture();
    f.open();
    const first = f.panel.read('chat', [])[0];
    f.record.segments.push({ kind: 'acp:gemini', nativeId: 'replacement' });
    if (onRead) assert.equal(f.panel.read('chat', []).length, 0);
    else assert.equal(await f.panel.answer('chat', first.id, 'decline', undefined, first.version), false);
    assert.equal(f.native.owner('chat', first.id.replace('panel:acp-form:', '')), null);
    assert.equal(await f.panel.answer('chat', first.id, 'cancel', undefined, first.version), false);
  }
  const f = fixture();
  f.open();
  delete f.host.questions;
  assert.equal(f.panel.read('chat', []).length, 0);
  assert.equal(await f.panel.answer('chat', 'panel:acp-form:missing', 'submit', {}, 'version'), false);
});

test('decline and cancel use the native owner, and an unavailable native connection without error text stays terminal', async () => {
  for (const choice of ['decline', 'cancel']) {
    const f = fixture();
    f.open();
    const first = f.panel.read('chat', [])[0];
    assert.equal(await f.panel.answer('chat', first.id, choice, undefined, first.version), true);
    assert.equal(f.sent[0].action, choice);
  }
  const f = fixture();
  f.open();
  const first = f.panel.read('chat', [])[0];
  f.response({ status: 'failed' });
  await assert.rejects(f.panel.answer('chat', first.id, 'decline', undefined, first.version), /no longer available/);
  const failed = f.panel.read('chat', [])[0];
  assert.equal(failed.disabled, true);
  assert.equal(failed.detail, 'The answer could not be delivered.');
});
