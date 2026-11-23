// Form-producing Claude/Codex adapters through the real Host protocol: live delivery, replay, feature filtering and one answer back to the original request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProtocol } from '../host/src/protocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createTurnBridge } from '../host/src/turnBridge.mjs';
import { createCodexStream } from '../host/src/codexStream.mjs';
import { USER_INPUT, ELICITATION, replyOf } from '../host/src/codexAsk.mjs';
import { helloParams } from '../shared/host/schema.mjs';

const schema = { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] };
const questions = [{ id: 'word', header: 'Colour', question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }];

for (const family of ['claude', 'codex'] as const) {
  for (const [kind, own] of [
    ['question', false],
    ['question', true],
    ['elicitation', false],
  ] as const) {
    test(`${family} ${kind}${own ? ' in the card’s own words' : ''}: a real producer reaches live/replaying peers, hides from old peers and takes an answer once`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-wire-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const chatId = family === 'claude' ? 'claude:question-wire' : 'question-wire';
      const host: any = new EventEmitter();
      host.cancel = () => undefined;
      const answers: any[] = [];
      let permit: (p: any) => boolean;
      const emit = (event: object) => host.emit('event', event);
      let produce: () => void;
      if (family === 'claude') {
        const bridge = createTurnBridge({
          state: { get: () => ({ activeTurn: { id: 'pending-t1' } }) },
          emit,
          controller: () => ({ ref: () => ({ kind: 'claude' }), chatOf: (key: string) => key, resolveApproval: () => undefined }) as any,
          answer: (id, answer) => {
            answers.push({ id, answer });
            return true;
          },
        });
        permit = bridge.permit;
        produce = () => {
          bridge.patched({ chatId, patch: { turn: 'running' } });
          bridge.harnessEvent(
            kind === 'question'
              ? {
                  kind: 'permission',
                  key: chatId,
                  requestId: 'ask-1',
                  toolName: 'AskUserQuestion',
                  toolUseID: 'tool-1',
                  input: { questions },
                }
              : {
                  kind: 'elicitation',
                  key: chatId,
                  requestId: 'ask-1',
                  mode: 'form',
                  serverName: 'probe',
                  message: 'Word?',
                  requestedSchema: schema,
                },
          );
        };
      } else {
        const stream = createCodexStream({ chatOf: () => chatId, emit });
        permit = (p) => {
          const card = stream.take(p.requestId);
          if (!card?.ask) return false;
          answers.push({ id: card.id, answer: replyOf(card as any, p) });
          return true;
        };
        produce = () => {
          stream.started(chatId, 't1', 'Ask me.');
          assert.equal(
            stream.ask(
              {
                id: 17,
                method: kind === 'question' ? USER_INPUT : ELICITATION,
                params: { threadId: 'native-1', turnId: 't1', questions, message: 'Word?', requestedSchema: schema },
              },
              chatId,
            ),
            true,
          );
        };
      }
      const runtime: any = { host, familyOf: () => family, permit: (p: any) => permit(p) };
      const quiet = { report: () => undefined };
      const epochs = createEpochStore(path.join(dir, 'epochs.json'), quiet);
      const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'ledger'), quiet) });
      const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }) });
      const peer = async (modern: boolean) => {
        const messages: any[] = [];
        const conn = protocol.connection((message: object) => messages.push(message));
        t.after(() => conn.close());
        const hello = helloParams();
        await conn.call('host.hello', { ...hello, features: modern ? hello.features : hello.features.filter((f) => f !== 'stream2') });
        await conn.call('chat.subscribe', { chatId, epoch: 1, fromRev: 0 });
        const items = () =>
          messages.flatMap((m) =>
            m.frame?.t === 'hello' ? (m.frame.snapshot?.items ?? []) : m.frame?.t === 'durable' ? [m.frame.item] : [],
          );
        const cards = () => items().filter((i) => i.t === 'event' && i.event.kind === 'question');
        return { conn, items, cards };
      };
      const live = await peer(true);
      const old = await peer(false);
      produce();
      assert.equal(live.cards().length, 1, 'the producer emitted a form but the protocol discarded it');
      assert.equal(live.cards()[0].family, family);
      const question = live.cards()[0].event.question;
      assert.equal(question.status, 'pending');
      const replay = await peer(true);
      assert.deepEqual(replay.cards(), live.cards(), 'reconnect retains exactly the original request');
      assert.deepEqual(old.cards(), []);
      assert.deepEqual((await peer(false)).cards(), []);
      if (own) assert.equal(question.asked[0].id, family === 'claude' ? 'q0' : 'word', 'the questions as asked travel with it');
      else assert.equal(kind === 'question' ? question.asked.length : question.asked, kind === 'question' ? 1 : undefined);
      const form = own
        ? { action: 'accept', content: { answers: { [question.asked[0].id]: { answers: ['Purple'] } } } }
        : { action: 'accept', content: { [question.form.fields[0].key]: kind === 'question' ? 'Red' : 'Ada' } };
      const p = { chatId, epoch: 1, requestId: question.id, form };
      await assert.rejects(
        live.conn.call('chat.answer', { ...p, epoch: 0, key: 'stale-answer-001' }),
        (error: any) => error.code === 'stale_epoch',
      );
      assert.equal(answers.length, 0);
      assert.equal((await live.conn.call('chat.answer', { ...p, key: 'valid-answer-001' })).result.answered, true);
      assert.equal(answers.length, 1);
      await assert.rejects(live.conn.call('chat.answer', { ...p, key: 'valid-answer-002' }), (e: any) => e.code === 'card_answered');
      assert.equal(answers.length, 1);
      const expected =
        kind === 'elicitation'
          ? { action: 'accept', content: { word: 'Ada' }, ...(family === 'codex' ? { _meta: null } : {}) }
          : family === 'claude'
            ? { behavior: 'allow', updatedInput: { questions, answers: { 'Which colour?': own ? 'Purple' : 'Red' } } }
            : { answers: { word: { answers: [own ? 'Purple' : 'Red'] } } };
      assert.deepEqual(JSON.parse(JSON.stringify(answers[0].answer)), expected);
      const cancelled = live.items().filter((i) => i.t === 'event' && i.event.kind === 'permissionCancelled');
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0].event.requestId, question.id);
      assert.equal((await peer(true)).items().filter((i) => i.event?.kind === 'permissionCancelled').length, 1);
    });
  }
}
