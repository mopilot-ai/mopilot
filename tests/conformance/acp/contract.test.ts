// Contract scenarios for every basic-tier quirks file (electron/harness/quirks/<id>.cjs), run through
// the real ACP adapter, the real admission probe and the real sage-mcp channel against
// tests/fixtures/fake-acp-agent.mjs configured to mimic what that harness declares (design
// harnessPlan, research in design-in/harnesses.txt and dsh.txt). Each runs: admission, new chat,
// send and streaming, an approval with the harness's own options, MoPilot's tools (auto-allowed
// and called through sage-mcp, as desktop and browser tasks are), Stop, and a restart that reopens
// the session the way the harness can. dsh also gets its privacy patch, env and fail-closed gate.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ensureSageMcp } from '../../../scripts/build-sage-mcp.mjs';
import { app, installFake, openHost, probeFake, said, tempDir, toolChannel, turn, until } from '../lib/acp.mjs';
import { transcriptFixture } from '../../support/transcript-fixture.ts';

const quirks = app().quirks;
// built once per run, under a lock shared with the other test files (a failed build fails here, loudly)
const builtBin = ensureSageMcp({ log: console.error });
const skip = builtBin ? false : 'needs macOS with a swift toolchain to build sage-mcp';

import { loadMimic } from '../../support/acpConformanceMimics.ts';

const dir = tempDir('sage-acp-contract-');
const fixture = transcriptFixture(dir);
// dsh is set up only with a DeepSeek key (quirks/dsh.cjs hasKey, which reads names only): give the run its own DSH_HOME
// with one, so the contract never depends on the developer's ~/.dsh
process.env.DSH_HOME = path.join(dir, 'dsh-home');
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.DSH_HOME, '.env'), 'DEEPSEEK_API_KEY=placeholder\n');
let tools_: ReturnType<typeof toolChannel> | null = null;
after(() => {
  fixture.stopWith(() => tools_?.close());
  return fixture.cleanup();
});

/** The tool channel (sage-mcp), opened on first use. */
const tools = () => (tools_ ??= toolChannel({ echo: true })).channel;
const install = (id: string, profile: Record<string, unknown>, name = id) => installFake(dir, id, profile, name);
const host = (id: string, inst: ReturnType<typeof install>, admitted: () => string | null = () => null) => {
  const result = openHost({ id, inst, tools: tools(), cwd: dir, admitted });
  fixture.own(result.h.items);
  fixture.stopWith(result.stop);
  return result;
};

// runs without sage-mcp too (CI's Linux skips the contract below): the mimic of each harness keeps every mode its quirks
// anchor and its plan, so a mode the app learns about reaches the contract (#1319)
test('the mimics declare every mode the quirks anchor, and each plan', () => {
  for (const id of quirks.ids()) {
    const q = quirks.quirks(id);
    const profile: any = loadMimic(id);
    const ids = new Set([
      ...(profile.modes?.availableModes ?? []).map((m: any) => m.id),
      ...((profile.configOptions ?? []).find((o: any) => o.id === 'mode')?.options ?? []).map((o: any) => o.value),
    ]);
    for (const m of Object.keys(q.anchors ?? {})) assert.ok(ids.has(m), `${id}: the mimic has no mode ${m}`);
    if (q.plan) assert.ok(ids.has(q.plan.mode ?? q.plan.value), `${id}: the mimic has no plan mode`);
  }
});

// a harness that takes no stdio MCP server gets the tools from main's http endpoint, whose peer check runs macOS's
// /usr/sbin/lsof (capabilities/httpMcp.cjs): off a Mac its admission cannot pass, so it is checked on the Mac only
const httpSkip = (id: string) =>
  quirks.quirks(id).mcpStdio === false && process.platform !== 'darwin' ? 'its tools come over http, checked by macOS lsof' : false;

for (const id of quirks.ids()) {
  test(`contract: ${id}`, { skip: skip || httpSkip(id), timeout: 120_000 }, async () => {
    const q = quirks.quirks(id);
    assert.deepEqual(quirks.validate(q), [], 'the quirks file is complete');
    const profile = loadMimic(id);
    const inst = install(id, profile);
    const cwd = path.join(inst.home, 'repo');
    fs.mkdirSync(cwd, { recursive: true });

    // admission: privacy check, initialize, session/new with sage_<nonce> and its hello
    const adm = await probeFake(id, inst, tools());
    assert.equal(adm.state, 'admitted', adm.reason);

    const { h, events } = host(id, inst);
    const key = `acp:${id}:contract`;
    // new chat, send, streaming
    const t1 = await turn(h, events, key, cwd, 'hello contract');
    assert.equal(t1.end.stopReason, 'end_turn');
    assert.equal(t1.reply, 'fake-acp: hello contract');
    assert.ok(events.filter((e) => e.kind === 'update' && e.turnId === t1.turnId).length > 1, 'streamed in chunks');

    // what it declared reaches the chat; anchors and plan point at modes it has
    const session = events.find((e) => e.kind === 'session');
    assert.deepEqual(session.modes ?? null, profile.modes ?? null);
    assert.deepEqual(session.anchors, q.anchors ?? {});
    // a mode is a modes entry or a value of the `mode` config option
    const modeIds = new Set([
      ...((profile.modes as any)?.availableModes ?? []).map((m: any) => m.id),
      ...(((profile.configOptions as any[]) ?? []).find((o) => o.id === 'mode')?.options ?? []).map((o: any) => o.value),
    ]);
    for (const m of Object.keys(q.anchors ?? {})) assert.ok(modeIds.has(m), `anchor for a mode ${id} has: ${m}`);
    if (q.plan?.mode) assert.ok(modeIds.has(q.plan.mode), 'plan is one of its modes');
    if (q.plan?.configOption) {
      const opt = (profile.configOptions as any[]).find((o) => o.id === q.plan.configOption);
      assert.ok(
        opt?.options.some((o: any) => o.value === q.plan.value),
        'plan is one of its config values',
      );
    }
    if (profile.commands)
      await until(() => events.some((e) => e.kind === 'update' && e.update.sessionUpdate === 'available_commands_update'));

    // an approval with the harness's own options, answered by option id
    const t2 = await turn(h, events, key, cwd, 'PERMIT now');
    const card = events.find((e) => e.kind === 'permission');
    assert.deepEqual(
      card.options,
      profile.permissionOptions ?? [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    );
    assert.ok(
      events.some(
        (e) =>
          e.kind === 'update' && e.turnId === t2.turnId && e.update.sessionUpdate === 'tool_call_update' && e.update.status === 'completed',
      ),
    );

    // MoPilot's tools: allowed once without a card, and called through sage-mcp
    const word = `w${Date.now().toString(36)}`;
    const t3 = await turn(h, events, key, cwd, `SAGEPERMIT MCPCALL ${word}`);
    assert.match(t3.reply, /\[sage-permit: allow[-_]once\]|\[sage-permit: allow\]/);
    assert.match(t3.reply, new RegExp(`\\[mcp sage_[0-9a-f]{12}: echo: ${word}\\]`));
    assert.equal(events.filter((e) => e.kind === 'permission').length, 1);

    // Stop
    const { turnId: slow } = await h.send(key, { cwd, blocks: [{ type: 'text', text: 'SLOW' }], display: [] }, {});
    await until(() => said(events, slow));
    h.cancel(key);
    assert.equal((await until(() => events.find((e) => e.kind === 'turnEnd' && e.turnId === slow))).stopReason, 'cancelled');

    // restart: reopened the way the harness can, with its history
    h.closeAll();
    const again = host(id, inst);
    const t4 = await turn(again.h, again.events, key, cwd, 'HISTORY');
    const reopened = again.events.find((e) => e.kind === 'session');
    const methods = inst
      .agentLog()
      .filter((l) => l.kind === 'in')
      .map((l) => l.msg.method);
    if (profile.loadSession) {
      assert.ok(methods.includes('session/load'));
      assert.match(t4.reply, /\[history: 3\]/);
    } else if (profile.resume) {
      assert.ok(methods.includes('session/resume'));
      assert.match(t4.reply, /\[history: 3\]/);
    } else {
      assert.match(reopened.note, /can't reopen sessions/);
      assert.match(t4.reply, /\[history: 0\]/);
    }
  });
}

test('dsh: launched with its patch and telemetry off; the gate fails closed when the patch stops applying', {
  skip,
  timeout: 60_000,
}, async () => {
  const ok = install('dsh', loadMimic('dsh'), 'dsh-argv');
  const { h, events } = host('dsh', ok);
  await turn(h, events, 'acp:dsh:argv', ok.home, 'hi');
  const starts = ok.agentLog().filter((l) => l.kind === 'argv');
  const acpStart = starts.find((l) => !l.argv.includes('--dump-config'));
  const patchFile = path.join(ok.dataDir, 'dsh', 'sage.patch.yml');
  assert.deepEqual(acpStart.argv, ['--profile', 'acp', '--patch', patchFile]);
  assert.equal(acpStart.env.DSH_TELEMETRY_DISABLED, '1');
  assert.match(fs.readFileSync(patchFile, 'utf8'), /- id: session-log-deepseek\n {2}config:\n {4}enabled: false/);
  assert.match(fs.readFileSync(patchFile, 'utf8'), /- id: session-telemetry-otel\n {2}config:\n {4}mode: DISABLED/);
  // the gate ran first, with the same arguments
  assert.deepEqual(starts[0].argv, ['--profile', 'acp', '--patch', patchFile, '--dump-config']);
  h.closeAll();

  // a dsh whose dump shows the session log still on: not admitted, and never started
  const bad = install('dsh', { ...loadMimic('dsh'), dumpConfig: 'ignoresPatch' }, 'dsh-bad');
  const adm = await probeFake('dsh', bad, tools());
  assert.equal(adm.state, 'unsupported');
  assert.equal(adm.reason, "This dsh version can't turn off session log upload");
  const b = host('dsh', bad);
  await assert.rejects(
    b.h.send('acp:dsh:bad', { cwd: bad.home, blocks: [{ type: 'text', text: 'hi' }], display: [] }, {}),
    /can't turn off session log upload/,
  );
  assert.ok(
    bad
      .agentLog()
      .filter((l) => l.kind === 'argv')
      .every((l) => l.argv.includes('--dump-config')),
    'only the gate ran',
  );

  // a dsh whose dump shows the telemetry still on, though the session log is off: not admitted either
  const tel = install('dsh', { ...loadMimic('dsh'), dumpConfig: 'telemetryIgnoresPatch' }, 'dsh-tel');
  const admTel = await probeFake('dsh', tel, tools());
  assert.equal(admTel.state, 'unsupported');
  assert.equal(admTel.reason, "This dsh version can't turn off its telemetry");

  // its parser: JSON or YAML trees, telemetry rows, unknown shapes fail closed
  const { readDump } = quirks.quirks('dsh')._test;
  assert.deepEqual(
    readDump(
      JSON.stringify([
        { id: 'session-log-deepseek', config: { enabled: false } },
        { id: 'session-telemetry-otel', disabled: true },
      ]),
    ),
    { sessionLog: 'off', telemetry: 'off' },
  );
  assert.deepEqual(readDump('- id: session-log-deepseek\n  disabled: true\n'), { sessionLog: 'off', telemetry: 'absent' });
  assert.deepEqual(readDump('- id: session-log-deepseek\n  config:\n    enabled: true\n'), { sessionLog: 'on', telemetry: 'absent' });
  assert.equal(readDump('nothing useful').sessionLog, 'unknown');
  assert.equal(readDump('- id: session-log-deepseek\n- id: session-telemetry-otel\n  config:\n    mode: FEEDBACK_ONLY\n').telemetry, 'on');
});

test('cursor: its extension methods map onto the thread; others are not supported', { skip, timeout: 60_000 }, async () => {
  const inst = install('cursor', loadMimic('cursor'), 'cursor-ext');
  const { h, events } = host('cursor', inst);
  const t = await turn(h, events, 'acp:cursor:ext', inst.home, 'EXT cursor/update_todos');
  assert.match(t.reply, /\[ext: \{\}\]/);
  const plan = events.find((e) => e.kind === 'update' && e.update.sessionUpdate === 'plan');
  assert.deepEqual(plan.update.entries, [{ content: 'first step', status: 'in_progress', priority: 'medium' }]);
  const t2 = await turn(h, events, 'acp:cursor:ext', inst.home, 'EXT cursor/ask_question');
  assert.match(t2.reply, /Method not found: cursor\/ask_question/);
});

test('qwen turns its usage statistics off at launch, which are on by default', () => {
  const q = quirks.quirks('qwen');
  assert.equal(q.env.QWEN_USAGE_STATISTICS_ENABLED, 'false');
  assert.ok(q.privacyDefaults.some((d: string) => /usage statistics/.test(d)));
});
