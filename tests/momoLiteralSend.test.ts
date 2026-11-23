// A MoMo chat's text reaches its harness as plain text, never one of the harness's own commands (shared/momoCommands.mjs
// momoLiteralText): Claude Code's CLI line (claude/message.cjs literalMessage, through sessionOptions.cjs
// buildUserMessage) and an ACP agent's prompt (acp/prompt.cjs). A coding chat's text goes as typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LITERAL_MARK, momoLiteralText } = await import('../shared/momoCommands.mjs');
const { literalMessage } = require('../electron/harness/claude/message.cjs');
const { buildUserMessage } = require('../electron/harness/claude/sessionOptions.cjs');
const { sendPrompt } = require('../electron/harness/acp/prompt.cjs');

/**
 * Whether Claude Code reads a user message as its own command: CLI 2.1.311 takes the message's string content, or the
 * text of its last block when that is a text block (`hj`), and runs it as a command when it `startsWith("/")`, untrimmed.
 */
const cliRunsAsCommand = (content: any) => {
  const text = typeof content === 'string' ? content : content.at(-1)?.type === 'text' ? content.at(-1).text : null;
  return text !== null && text.startsWith('/');
};

test('text that starts with "/" or "!" gets the invisible mark; anything else, and a non-string, is left as it is', () => {
  assert.equal(LITERAL_MARK, '​');
  for (const t of ['/clear', '/new chat', '!ls', '/']) assert.equal(momoLiteralText(t), `​${t}`);
  for (const t of ['hello', ' /clear', 'a /b', '', '<momo-context>\n…\n</momo-context>\n\n/clear']) assert.equal(momoLiteralText(t), t);
  assert.equal(momoLiteralText(null as any), null);
  // the mark survives every trim a harness might do
  assert.ok(momoLiteralText('/clear').trim().startsWith(LITERAL_MARK));
});

test('Claude Code: a MoMo message is never a CLI command, as a string or with its text last; other shapes are left alone', () => {
  for (const content of [
    '/clear',
    [
      { type: 'image', source: {} },
      { type: 'text', text: '/compact now' },
    ],
  ]) {
    assert.equal(cliRunsAsCommand(content), true, 'the CLI would run it as typed');
    const literal = literalMessage({ role: 'user', content });
    assert.equal(cliRunsAsCommand(literal.content), false, JSON.stringify(content));
  }
  // only the last block is read: earlier ones and a trailing image are left as they are
  const image = {
    role: 'user',
    content: [
      { type: 'text', text: '/clear' },
      { type: 'image', source: {} },
    ],
  };
  assert.equal(literalMessage(image), image);
  const head = {
    role: 'user',
    content: [
      { type: 'text', text: '/a' },
      { type: 'text', text: 'hi' },
    ],
  };
  assert.deepEqual(literalMessage(head), head);
  assert.deepEqual(literalMessage({ role: 'user', content: [] }), { role: 'user', content: [] });
  assert.deepEqual(literalMessage({ role: 'user' } as any), { role: 'user' });
});

test('the CLI line carries the literal message only for a MoMo chat (literal), with its uuid and origin as before', () => {
  const momo = buildUserMessage({ role: 'user', content: '/clear' }, { uuid: 'u1', human: true, literal: true });
  assert.equal(momo.message.content, '​/clear');
  assert.equal(momo.uuid, 'u1');
  assert.deepEqual(momo.origin, { kind: 'human' });
  const coding = buildUserMessage({ role: 'user', content: '/clear' }, { uuid: 'u2' });
  assert.equal(coding.message.content, '/clear', "a coding chat's /clear is the CLI's command");
});

function acpHost(isolated: boolean) {
  const sent: any[] = [];
  const chat: any = {
    key: 'k',
    harness: 'kimi',
    sessionId: 's',
    isolated,
    state: {},
    agent: { caps: { image: true }, request: (m: string, p: any) => (sent.push([m, p]), new Promise(() => {})) },
  };
  const host: any = {
    label: () => 'Kimi',
    starting: new Map(),
    ensure: async () => chat,
    items: { append: () => {} },
    emitEvent: () => {},
    now: () => 0,
    audioDispatch: {},
  };
  return { host, sent };
}

test('ACP: a MoMo chat’s text blocks lose their leading command; a coding chat’s prompt goes as given', async () => {
  const blocks = [
    { type: 'text', text: 'note for the model', annotations: { audience: ['assistant'] } },
    { type: 'text', text: '/new' },
    { type: 'image', mimeType: 'image/png', data: 'x' },
  ];
  const momo = acpHost(true);
  await sendPrompt(momo.host, 'k', { blocks, display: [] });
  assert.deepEqual(
    momo.sent[0][1].prompt.map((b: any) => b.text ?? b.type),
    ['note for the model', '​/new', 'image'],
  );
  const coding = acpHost(false);
  await sendPrompt(coding.host, 'k', { blocks, display: [] });
  assert.equal(coding.sent[0][1].prompt, blocks);
});

test('explicit compaction maintenance remains a native action while ordinary MoMo slash text stays literal', async () => {
  const compact = { args: '' };
  const line = buildUserMessage({ role: 'user', content: '/compact' }, { literal: true, compact });
  assert.equal(line.message.content, '/compact');
  const ordinary = buildUserMessage({ role: 'user', content: '/compact' }, { literal: true });
  assert.equal(ordinary.message.content, `${LITERAL_MARK}/compact`);
  const momo = acpHost(true);
  await sendPrompt(momo.host, 'k', { blocks: [{ type: 'text', text: '/compress' }], display: [] }, { compact });
  assert.equal(momo.sent[0][1].prompt[0].text, '/compress');
});
