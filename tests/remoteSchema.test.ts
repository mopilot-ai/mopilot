// The schema the Chrome panel and phones share: every method's params normalized, and each refusal says what to fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARSERS,
  SchemaError,
  parseParams,
  knownMethod,
  tabLine,
  audioOf,
  chatOf,
  targetOf,
  optionOf,
  maybeOption,
  attachmentsOf,
  skillsOf,
  pickOf,
  projectOf,
  composed,
  MAX_TEXT,
} from '../shared/remote/schema.mjs';

const bad = (method: string, params: unknown, message: RegExp) =>
  assert.throws(
    () => parseParams(method, params),
    (e: any) => e instanceof SchemaError && e.code === 'invalid' && message.test(e.message),
    method,
  );

test('every method has a parser, and unknown ones are refused', () => {
  for (const m of Object.keys(PARSERS)) assert.equal(knownMethod(m), true);
  assert.equal(knownMethod('chat.nope'), false);
  assert.equal(knownMethod(7), false);
  assert.equal(knownMethod('constructor'), false);
  bad('chat.nope', {}, /Unknown request: chat.nope/);
  assert.deepEqual(parseParams('machine.hello', 'not an object'), {});
  assert.deepEqual(parseParams('projects.list', null), {});
});

test('chat ids, harnesses, options, attachments, skills and projects are checked', () => {
  assert.equal(chatOf({ chatId: 'claude:abc-1' }), 'claude:abc-1');
  assert.throws(() => chatOf({ chatId: 'bad id' }), /isn't in MoPilot/);
  assert.throws(() => chatOf({}), /isn't in MoPilot/);
  assert.throws(() => chatOf(undefined), /isn't in MoPilot/);
  assert.deepEqual(targetOf({ chatId: 'c1' }), { chatId: 'c1' });
  assert.deepEqual(targetOf({ harness: 'acp:kimi' }), { harness: 'acp:kimi' });
  assert.throws(() => targetOf({ harness: 'gemini' }), /Pick a harness for the new chat/);
  assert.throws(() => targetOf({}), /Pick a harness for the new chat/);
  assert.equal(optionOf('claude-fable-5-1[1m]'), 'claude-fable-5-1[1m]');
  assert.throws(() => optionOf('has space'), /isn't one MoPilot has/);
  assert.throws(() => optionOf(4), /isn't one MoPilot has/);
  assert.equal(maybeOption(undefined), null);
  assert.equal(maybeOption('high'), 'high');
  assert.deepEqual(attachmentsOf(undefined), []);
  assert.deepEqual(attachmentsOf(['0123456789abcdef']), ['0123456789abcdef']);
  assert.throws(() => attachmentsOf('x'), /Attach those files again/);
  assert.throws(() => attachmentsOf(['nope']), /Attach those files again/);
  assert.throws(() => attachmentsOf(Array(11).fill('0123456789abcdef')), /Attach those files again/);
  assert.deepEqual(skillsOf(undefined), []);
  assert.deepEqual(skillsOf(['review:code']), ['review:code']);
  assert.throws(() => skillsOf('x'), /skills/);
  assert.throws(() => skillsOf(['bad skill']), /skills/);
  assert.deepEqual(pickOf({ model: 'm', effort: null }), { model: 'm', effort: null, attachments: [], skills: [] });
  assert.equal(projectOf({}), null);
  assert.equal(projectOf({ projectId: 'p_1' }), 'p_1');
  assert.throws(() => projectOf({ projectId: 'a b' }), /isn't in MoPilot/);
});

test('a message is trimmed, bounded and carries the Chrome tab line only for a web page', () => {
  assert.equal(composed({ text: '  hi  ' }), 'hi');
  assert.equal(composed({ text: 'hi', tab: { url: 'https://a.example/x' } }), 'hi\n\n[Chrome tab: https://a.example/x]');
  assert.equal(composed({ text: 'hi', tab: { url: 'chrome://settings' } }), 'hi');
  assert.equal(composed({ text: 'hi', tab: { url: 'not a url' } }), 'hi');
  assert.equal(composed({ text: 'hi', tab: 'x' }), 'hi');
  assert.throws(() => composed({ text: '   ' }), /Type a message first/);
  assert.throws(() => composed({}), /Type a message first/);
  assert.throws(() => composed({ text: 'x'.repeat(MAX_TEXT + 1) }), /too long/);
  assert.equal(tabLine(null), null);
});

test('audio is base64 within bounds', () => {
  assert.deepEqual(audioOf('aGk='), Buffer.from('hi'));
  assert.throws(() => audioOf(''), /couldn't be read/);
  assert.throws(() => audioOf(5), /couldn't be read/);
  assert.throws(() => audioOf('***'), /couldn't be read/);
  assert.throws(() => audioOf('A'.repeat(40_000_000)), /too long/);
});

test('harnesses.list asks for states only when told to', () => {
  assert.deepEqual(parseParams('harnesses.list', {}), { states: false });
  assert.deepEqual(parseParams('harnesses.list', { states: 'yes' }), { states: false });
  assert.deepEqual(parseParams('harnesses.list', { states: true }), { states: true });
});

test('list, pin, follow, read, stop and switch normalize their params', () => {
  assert.deepEqual(parseParams('chats.recent', {}), { limit: 20, archived: false, offset: 0 });
  assert.deepEqual(parseParams('chats.recent', { limit: 9999, archived: true }), { limit: 200, archived: true, offset: 0 });
  assert.deepEqual(parseParams('chats.recent', { limit: 0 }), { limit: 1, archived: false, offset: 0 });
  assert.deepEqual(parseParams('chats.recent', { limit: 50, offset: 150 }), { limit: 50, archived: false, offset: 150 });
  for (const offset of [-5, 1.5, '3', null, NaN])
    assert.equal((parseParams('chats.recent', { offset }) as { offset: number }).offset, 0, `offset ${String(offset)}`);
  assert.equal((parseParams('chats.recent', { offset: 10 ** 9 }) as { offset: number }).offset, 10_000, 'a page start is bounded');
  assert.deepEqual(parseParams('chats.pin', { chatId: 'c1', pinned: true }), { chatId: 'c1', pinned: true });
  assert.deepEqual(parseParams('chats.pin', { chatId: 'c1' }), { chatId: 'c1', pinned: false });
  assert.deepEqual(parseParams('chat.follow', { chatId: 'c1' }), { chatId: 'c1', items: 50 });
  assert.deepEqual(parseParams('chat.follow', { chatId: 'c1', items: 5000 }), { chatId: 'c1', items: 200 });
  assert.deepEqual(parseParams('chat.follow', { chatId: 'c1', items: -3 }), { chatId: 'c1', items: 0 });
  for (const m of ['chat.unfollow', 'chat.read', 'chat.stop']) {
    assert.deepEqual(parseParams(m, { chatId: 'c1' }), { chatId: 'c1' });
    bad(m, {}, /isn't in MoPilot/);
  }
  // a phone pages back from the oldest row it has
  assert.deepEqual(parseParams('chat.read', { chatId: 'c1', before: 'row-1' }), { chatId: 'c1', before: 'row-1', limit: 40 });
  assert.deepEqual(parseParams('chat.read', { chatId: 'c1', before: 'row-1', limit: 5000 }), { chatId: 'c1', before: 'row-1', limit: 100 });
  assert.deepEqual(parseParams('chat.read', { chatId: 'c1', before: 'row-1', limit: 0 }), { chatId: 'c1', before: 'row-1', limit: 1 });
  assert.deepEqual(parseParams('chat.read', { chatId: 'c1', before: 'row-1', limit: 'many' }), {
    chatId: 'c1',
    before: 'row-1',
    limit: 40,
  });
  for (const before of ['', 5, null, 'x'.repeat(2049)]) bad('chat.read', { chatId: 'c1', before }, /not available/);
  assert.deepEqual(parseParams('chat.switch', { chatId: 'c1', harness: 'codex' }), { chatId: 'c1', harness: 'codex' });
  bad('chat.switch', { chatId: 'c1', harness: 'x' }, /Pick a harness\./);
  for (const m of ['projects.list', 'scheduled.list', 'dictation.engine', 'device.unpair']) assert.deepEqual(parseParams(m, {}), {});
  assert.deepEqual(parseParams('panel.browserSettings', { a: 1 }), { a: 1 });
});

test('send and start carry the message, the picks, the tab and the deadline', () => {
  assert.deepEqual(parseParams('chat.send', { chatId: 'c1', text: 'hi', model: 'm', deadline: 5, tab: { url: 'https://a.example/' } }), {
    chatId: 'c1',
    text: 'hi\n\n[Chrome tab: https://a.example/]',
    model: 'm',
    effort: null,
    attachments: [],
    skills: [],
    tab: { url: 'https://a.example/' },
    deadline: 5,
  });
  bad('chat.send', { chatId: 'c1', text: '' }, /Type a message first/);
  assert.deepEqual(
    parseParams('chat.start', { harness: 'claude', text: 'go', projectId: 'p1', retainOnError: true, permission: 'default' }),
    {
      harness: 'claude',
      text: 'go',
      projectId: 'p1',
      retainOnError: true,
      model: null,
      effort: null,
      attachments: [],
      skills: [],
      permission: 'default',
    },
  );
  assert.deepEqual(parseParams('chat.start', { harness: 'codex', text: 'go' }), {
    harness: 'codex',
    text: 'go',
    projectId: null,
    model: null,
    effort: null,
    attachments: [],
    skills: [],
  });
  bad('chat.start', { harness: 'x', text: 'go' }, /Pick a harness for the new chat/);
  bad('chat.start', { harness: 'codex', text: 'go', projectId: 'a b' }, /isn't in MoPilot/);
  bad('chat.start', { harness: 'codex', text: 'go', permission: 'a b' }, /isn't one MoPilot has/);
});

test('open, attach and transcribe', () => {
  assert.deepEqual(parseParams('chat.open', { chatId: 'c1', page: 'scheduled' }), { chatId: 'c1', page: 'scheduled' });
  assert.deepEqual(parseParams('chat.open', { page: 'elsewhere' }), { chatId: null, page: undefined });
  assert.deepEqual(parseParams('chat.attach', { dataUrl: 'data:text/plain;base64,aGk=', name: 'n.txt' }), {
    dataUrl: 'data:text/plain;base64,aGk=',
    name: 'n.txt',
  });
  assert.equal((parseParams('chat.attach', { dataUrl: 'data:x,y' }) as any).name, 'file');
  assert.equal((parseParams('chat.attach', { dataUrl: 'data:x,y', name: 'n'.repeat(500) }) as any).name.length, 200);
  bad('chat.attach', {}, /couldn't be read/);
  bad('chat.transcribe', {}, /couldn't be read/);
  bad('chat.attach', { dataUrl: 'http://x' }, /couldn't be read/);
  bad('chat.attach', { dataUrl: `data:${'a'.repeat(30_000_000)}` }, /larger than 20 MB/);
  const clip = parseParams('chat.transcribe', { mime: 'audio/wav', audio: 'aGk=' });
  assert.deepEqual(clip, { mime: 'audio/wav', audio: Buffer.from('hi'), clip: Buffer.from('hi') });
  assert.deepEqual((parseParams('chat.transcribe', { mime: 'audio/webm', audio: 'aGk=', clip: 'aGk=' }) as any).clip, Buffer.from('hi'));
  bad('chat.transcribe', { mime: 'audio/mp3', audio: 'aGk=' }, /couldn't be read/);
});

test('speech lease: transcribe carries the capture it was recorded under; begin needs one and a target; end passes its keys through', () => {
  const leased = parseParams('chat.transcribe', { mime: 'audio/wav', audio: 'aGk=', capture: 'cap', clientId: 'client' }) as any;
  assert.equal(leased.capture, 'cap');
  assert.equal(leased.clientId, 'client');
  assert.equal('capture' in (parseParams('chat.transcribe', { mime: 'audio/wav', audio: 'aGk=' }) as any), false);
  assert.deepEqual(parseParams('dictation.begin', { capture: true, clientId: 'client', generation: 2, chatId: 'c1' }), {
    clientId: 'client',
    generation: 2,
    target: { chatId: 'c1' },
  });
  assert.deepEqual((parseParams('dictation.begin', { capture: true, harness: 'codex' }) as any).target, { harness: 'codex' });
  bad('dictation.begin', { chatId: 'c1' }, /Update the MoPilot extension/);
  bad('dictation.begin', { capture: true }, /Pick a harness for the new chat/);
  assert.deepEqual(parseParams('dictation.end', { capture: 'cap', clientId: 'client', generation: 2 }), {
    capture: 'cap',
    clientId: 'client',
    generation: 2,
  });
  assert.deepEqual(parseParams('dictation.end', {}), { capture: undefined, clientId: undefined, generation: undefined });
});

test('menus: options, picks, permissions and commands', () => {
  assert.deepEqual(parseParams('options.get', { chatId: 'c1' }), { chatId: 'c1' });
  assert.deepEqual(parseParams('options.set', { chatId: 'c1', model: 'm', effort: 'high' }), { chatId: 'c1', model: 'm', effort: 'high' });
  assert.deepEqual(parseParams('options.set', { harness: 'codex', value: 'default' }), { harness: 'codex', value: 'default' });
  assert.deepEqual(parseParams('card.choose', { harness: 'codex', model: 'm' }), { harness: 'codex', model: 'm', effort: null });
  assert.deepEqual(parseParams('card.permit', { chatId: 'c1', value: 'default' }), { chatId: 'c1', value: 'default' });
  bad('card.permit', { chatId: 'c1' }, /isn't one MoPilot has/);
  assert.deepEqual(parseParams('commands.list', { chatId: 'c1' }), { chatId: 'c1' });
  assert.deepEqual(parseParams('commands.list', { harness: 'codex', projectId: 'p1' }), { harness: 'codex', projectId: 'p1' });
  assert.deepEqual(parseParams('commands.list', { harness: 'codex' }), { harness: 'codex', projectId: null });
});

test('an answer names the chat, the card and the key; a rev and version are optional', () => {
  assert.deepEqual(parseParams('card.answer', { chatId: 'c1', cardId: 'a1', key: 'once' }), { chatId: 'c1', cardId: 'a1', key: 'once' });
  assert.deepEqual(parseParams('card.answer', { chatId: 'c1', cardId: 12, key: 'once', rev: 3, version: 7, values: { a: 1 } }), {
    chatId: 'c1',
    cardId: 12,
    key: 'once',
    rev: 3,
    version: '7',
    values: { a: 1 },
  });
  bad('card.answer', { chatId: 'c1', key: 'once' }, /Pick one of the choices/);
  bad('card.answer', { chatId: 'c1', cardId: 'a1', key: '' }, /Pick one of the choices/);
  bad('card.answer', { chatId: 'c1', cardId: 1.5, key: 'once' }, /Pick one of the choices/);
  bad('card.answer', { chatId: 'c1', cardId: 'a1', key: 'once', rev: 'x' }, /already answered/);
  bad('card.answer', { cardId: 'a1', key: 'once' }, /isn't in MoPilot/);
});

test('chat.switch may carry the login the chat goes on: a login id, null for the agent’s own choice, or none', () => {
  assert.deepEqual(parseParams('chat.switch', { chatId: 'c', harness: 'codex' }), { chatId: 'c', harness: 'codex' });
  assert.deepEqual(parseParams('chat.switch', { chatId: 'c', harness: 'codex', account: 'a1' }), {
    chatId: 'c',
    harness: 'codex',
    account: 'a1',
  });
  assert.deepEqual(parseParams('chat.switch', { chatId: 'c', harness: 'codex', account: null }), {
    chatId: 'c',
    harness: 'codex',
    account: null,
  });
  assert.throws(() => parseParams('chat.switch', { chatId: 'c', harness: 'codex', account: 'bad id!' }));
});
