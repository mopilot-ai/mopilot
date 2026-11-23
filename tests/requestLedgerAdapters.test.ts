// What the request ledger reads from the adapters themselves: the model and effort a Codex turn asked for, on the
// adapter's turnStarted (electron/harness/codexTurns.cjs), and the usage an ACP agent's prompt response counted, on
// the host's turnEnd (electron/harness/acp.cjs). Neither changes what the windows already get.
import { test, assert, setup as codexSetup } from './support/codex-adapter/fixture.ts';
import { until, KEY, CWD, setup as acpSetup } from './support/acp-host/fixture.ts';

test("Codex: turnStarted names the model and effort turn/start asked for, or none when the app-server's default is unknown", async () => {
  const picked = codexSetup({}, { segments: { chat1: 'seg' }, prefs: { model: 'gpt-5', effort: 'high' } });
  await picked.a.startTurn('chat1', { kind: 'codex', id: 'seg' }, { id: 'q', text: 'hi', attachments: [], opts: {} }, 1);
  const started = picked.events.find((x: any) => x.e.kind === 'turnStarted')!.e;
  assert.deepEqual([started.model, started.effort], ['gpt-5', 'high']);
  const unset = codexSetup({}, { segments: { chat1: 'seg' }, prefs: {} });
  await unset.a.startTurn('chat1', { kind: 'codex', id: 'seg' }, { id: 'q', text: 'hi', attachments: [], opts: {} }, 1);
  const bare = unset.events.find((x: any) => x.e.kind === 'turnStarted')!.e;
  assert.equal(bare.model, null);
});

test("ACP: a prompt response's usage rides on turnEnd; one without usage adds no field", async () => {
  const usage = { inputTokens: 10, outputTokens: 3, totalTokens: 13 };
  let answer: any = { stopReason: 'end_turn', usage };
  const t = acpSetup({ handlers: { 'session/prompt': () => Promise.resolve(answer) } });
  await t.host.ensure(KEY, { cwd: CWD });
  await t.host.send(KEY, { blocks: [{ type: 'text', text: 'hi' }] }, { uuid: 'u1' });
  await until(() => t.events.some((e: any) => e.kind === 'turnEnd'));
  assert.deepEqual(t.events.find((e: any) => e.kind === 'turnEnd').usage, usage);
  answer = { stopReason: 'end_turn' };
  await t.host.send(KEY, { blocks: [{ type: 'text', text: 'again' }] }, { uuid: 'u2' });
  await until(() => t.events.filter((e: any) => e.kind === 'turnEnd').length === 2);
  assert.equal('usage' in t.events.filter((e: any) => e.kind === 'turnEnd')[1], false);
});
