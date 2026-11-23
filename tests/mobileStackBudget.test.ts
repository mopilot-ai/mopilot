// Mobile Remote end to end, data budget (design: a followed turn costs the phone under 2 MB): a synthetic turn, a realistic heavy one that arrives whole, and one with huge tool outputs that is cut short; the wire carries each streamed word once, not the whole reply again for every word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until } from './support/mobileStack.ts';

const codex = {
  turn: (method: string, status: string) => ({ method, params: { threadId: 'new-chat', turn: { id: 't1', status } } }),
  item: (method: string, id: string, text: string) => ({
    method,
    params: {
      threadId: 'new-chat',
      turnId: 't1',
      item: { type: 'agentMessage', id, text, phase: null, memoryCitation: null, delivery: null },
    },
  }),
  delta: (id: string, delta: string) => ({
    method: 'item/agentMessage/delta',
    params: { threadId: 'new-chat', turnId: 't1', itemId: id, delta },
  }),
};

test('a followed turn of 800 streamed words and 20 tool outputs costs the phone under 2 MB, a small multiple of the text itself', async () => {
  const relay = await startRelay();
  const mac = await startMac(relay);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  mac.known.add('new-chat');
  await phone.ask('chat.follow', { chatId: 'new-chat' });
  const before = phone.bytes();

  mac.emit('codex', codex.turn('turn/started', 'inProgress'));
  mac.emit('codex', codex.item('item/started', 'm', ''));
  let text = '';
  for (let i = 0; i < 800; i++) {
    const word = `word${i} `;
    text += word;
    mac.emit('codex', codex.delta('m', word));
  }
  mac.emit('codex', codex.item('item/completed', 'm', text));
  let tools = 0;
  for (let i = 0; i < 20; i++) {
    const output = `line ${i}\n`.repeat(200);
    tools += output.length;
    for (const status of ['inProgress', 'completed']) {
      mac.emit('codex', {
        method: status === 'inProgress' ? 'item/started' : 'item/completed',
        params: {
          threadId: 'new-chat',
          turnId: 't1',
          item: {
            type: 'commandExecution',
            id: `x${i}`,
            command: 'npm test',
            cwd: '',
            processId: null,
            source: 'agent',
            status,
            commandActions: [],
            aggregatedOutput: status === 'inProgress' ? null : output,
            exitCode: status === 'inProgress' ? null : 0,
            durationMs: null,
            pluginId: null,
            scriptPath: null,
          },
        },
      });
    }
  }
  mac.emit('codex', codex.turn('turn/completed', 'completed'));
  await until(
    () => phone.eventsOf('turn.state').some((e: any) => e.completed || e.status === 'completed' || e.started === false),
    'the turn to finish',
    15000,
  );

  const after = phone.bytes();
  const received = after.in - before.in;
  const sent = after.out - before.out;
  const plain = text.length + tools;
  assert.ok(received + sent < 2 * 1024 * 1024, `the turn cost ${received + sent} bytes over the relay`);
  // sealed, base64 and framed, but never the reply again per word: a few times the text, not hundreds of times
  assert.ok(received < plain * 6, `${received} bytes received for ${plain} bytes of text`);
  // the Mac coalesces the 800 deltas instead of sending one event each
  assert.ok(phone.events.length < 200, `${phone.events.length} events reached the phone`);
  // acknowledgements are small beside the data they confirm
  assert.ok(sent < received / 3, `${sent} bytes sent against ${received} received`);
});

/** A pseudo-random log of about `bytes` characters: it does not compress to nothing. */
const log = (bytes: number, seed: number) => {
  let out = '';
  for (let i = 0; out.length < bytes; i++)
    out += `L${seed}.${i} ${'x'.repeat(40 + ((i * 7) % 30))} ${((i * 2654435761) % 99999).toString(36)}\n`;
  return out;
};
const command = (method: string, id: string, output: string | null, status: string, turnId: string) => ({
  method,
  params: {
    threadId: 'new-chat',
    turnId,
    item: {
      type: 'commandExecution',
      id,
      command: 'npm test',
      cwd: '',
      processId: null,
      source: 'agent',
      status,
      commandActions: [],
      aggregatedOutput: output,
      exitCode: output === null ? null : 0,
      durationMs: null,
      pluginId: null,
      scriptPath: null,
    },
  },
});

/**
 * A chat with `history` earlier turns, followed by the phone, then one more turn of `words` streamed words and one tool call per entry of
 * `outputs` (characters of output each). Resolves with what the phone paid from the follow to the end of the turn.
 */
async function followedTurn(o: { history: number; words: number; outputs: number[] }) {
  const relay = await startRelay();
  const mac = await startMac(relay);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  mac.known.add('new-chat');
  for (let h = 0; h < o.history; h++) {
    const turnId = `h${h}`;
    mac.emit('codex', codex.turn('turn/started', 'inProgress'));
    mac.emit('codex', {
      ...codex.item('item/completed', `hm${h}`, log(1500, h)),
      params: { ...codex.item('item/completed', `hm${h}`, log(1500, h)).params, turnId },
    });
    mac.emit('codex', command('item/completed', `hc${h}`, log(3000, h), 'completed', turnId));
    mac.emit('codex', codex.turn('turn/completed', 'completed'));
  }
  const before = phone.bytes();
  await phone.ask('chat.follow', { chatId: 'new-chat' });
  mac.emit('codex', codex.turn('turn/started', 'inProgress'));
  mac.emit('codex', codex.item('item/started', 'm', ''));
  let text = '';
  for (let i = 0; i < o.words; i++) {
    const word = `word${i} `;
    text += word;
    mac.emit('codex', codex.delta('m', word));
  }
  mac.emit('codex', codex.item('item/completed', 'm', text));
  o.outputs.forEach((chars, i) => {
    mac.emit('codex', command('item/started', `x${i}`, null, 'inProgress', 't1'));
    mac.emit('codex', command('item/completed', `x${i}`, log(chars, i), 'completed', 't1'));
  });
  mac.emit('codex', codex.turn('turn/completed', 'completed'));
  await until(() => phone.eventsOf('turn.state').some((e: any) => e.started === false), 'the turn to finish', 30000);
  const after = phone.bytes();
  const outputs = new Map<string, string>();
  for (const e of [...phone.eventsOf('items.append'), ...phone.eventsOf('items.replace')])
    for (const item of e.items ?? [])
      if (item.type === 'commandExecution' && item.id.startsWith('x') && item.aggregatedOutput) outputs.set(item.id, item.aggregatedOutput);
  // the assistant's words as the phone puts them together: the item, then every delta of its text
  const versions = [...phone.eventsOf('items.append'), ...phone.eventsOf('items.replace')]
    .flatMap((e: any) => e.items ?? [])
    .filter((item: any) => item.id === 'm');
  const message =
    (versions.at(-1)?.text ?? '') +
    phone
      .eventsOf('items.delta')
      .filter((e: any) => e.itemId === 'm' && e.field === 'text')
      .map((e: any) => e.text)
      .join('');
  return {
    cost: after.in - before.in + (after.out - before.out),
    outputs,
    message,
    text,
    plain: text.length + o.outputs.reduce((a, b) => a + b, 0),
  };
}

test('a realistic heavy turn (30 earlier turns, 1,500 words, 40 tool calls of 1 to 25 KB) costs the phone well under 2 MB and arrives whole', async () => {
  const outputs = Array.from({ length: 40 }, (_, i) => 1000 + (i % 7) * 4000);
  const t = await followedTurn({ history: 30, words: 1500, outputs });
  assert.ok(t.cost < 2 * 1024 * 1024, `the turn cost ${t.cost} bytes over the relay`);
  assert.ok(t.cost < t.plain * 2, `${t.cost} bytes for ${t.plain} characters of text`);
  assert.equal(t.outputs.size, 40);
  assert.ok(
    [...t.outputs.values()].every((out) => !out.includes('(shortened)')),
    'within the budget nothing is cut',
  );
  assert.ok(t.message === t.text, 'the assistant’s words arrive whole');
});

test('a turn with 30 tool outputs of 150 KB (4.5 MB of text) is held under 2 MB by cutting the later outputs, never the assistant’s words', async () => {
  const t = await followedTurn({ history: 30, words: 1500, outputs: Array(30).fill(150_000) });
  assert.ok(t.cost < 2 * 1024 * 1024, `the turn cost ${t.cost} bytes over the relay`);
  assert.equal(t.outputs.size, 30, 'every tool call still shows');
  assert.ok(!t.outputs.get('x0')!.includes('(shortened)'), 'the first outputs arrive whole');
  assert.ok(t.outputs.get('x29')!.includes('(shortened)'), 'the last ones are cut');
  assert.ok(t.outputs.get('x29')!.length < 2000);
  assert.ok(t.message === t.text, 'what the assistant wrote is whole');
});
