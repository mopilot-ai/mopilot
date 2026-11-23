// Real-login proof that calls in flight when a Host dies are settled by the next one and never sent again (#4278) on a locked mopilot-* VM: a real turn calls a tool this script announces as the app and does not answer, a browser navigation is left unanswered where the Host has a browser, the exact Host PID is killed, and the replacement Host ends the turn naming those calls as lost, closes the turn's cards, sends none of them again, and the chat carries on.
// Acquire the VM's vmlock.sh lock before invocation; never run this against the user's Mac or change any login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { channelFor, realDeps, runSteps } from '../scripts/host-accept.mjs';
import { exitCode, formatReport } from '../scripts/host-accept/report.mjs';
import { STEPS, cleanup, expect, until } from '../scripts/host-accept/steps.mjs';
import { lineClient } from '../scripts/host-accept/wire.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (/** @type {string} */ name) => process.argv[process.argv.indexOf(name) + 1];
const vm = arg('--vm');
const evidence = arg('--out');
const harness = process.argv.includes('--harness') ? arg('--harness') : 'codex';
if (!process.argv.includes('--vm') || !/^mopilot-[\w-]+$/.test(vm) || !process.argv.includes('--out') || !evidence)
  throw new Error('usage: host-calls-real.mjs --vm mopilot-* --out <evidence-dir> [--harness codex|claude] (hold that VM lock)');
fs.mkdirSync(evidence, { recursive: true });
const ctx = {
  m: channelFor(/** @type {any} */ ({ vm, ssh: '', sshArgs: [] })),
  deps: realDeps(),
  root: ROOT,
  target: vm,
  outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'host-calls-real-')),
  nonce: crypto.randomUUID().slice(0, 8),
  state: /** @type {any} */ ({}),
};
/** @type {ReturnType<typeof lineClient>[]} */
const clients = [];
async function connect() {
  const c = lineClient(ctx.m.open(`nc -U '${ctx.state.socket}'`), { timeoutMs: 120_000 });
  clients.push(c);
  await ctx.deps.authenticate(
    (/** @type {string} */ method, /** @type {object | undefined} */ params) => c.request(method, params),
    ctx.state.identity,
  );
  await c.request('host.hello', ctx.deps.helloParams());
  return c;
}
const frames = (/** @type {any} */ c, /** @type {string} */ chatId) =>
  c.events.filter((/** @type {any} */ e) => e.chatId === chatId && e.frame).map((/** @type {any} */ e) => e.frame);
/** The run-installed Host's PID, checked to be the Host. */
async function pid() {
  const info = await ctx.m.run('launchctl list ai.mopilot.host');
  const found = /"PID"\s*=\s*(\d+)/.exec(info.stdout)?.[1];
  expect(found && /^\d+$/.test(found), 'The run-installed service did not report its exact PID.');
  const command = await ctx.m.run(`ps -p ${found} -o command=`);
  expect(
    command.code === 0 && command.stdout.includes('mopilot-host.mjs') && command.stdout.includes('serve'),
    'PID does not belong to the installed Host.',
  );
  return /** @type {string} */ (found);
}

const TOOL = 'bench_send_note';
const toolEvents = (/** @type {any} */ c, /** @type {string} */ chatId) =>
  c.events.filter((/** @type {any} */ e) => e.event === 'tool' && e.chatId === chatId);

const step = {
  id: 'R-calls',
  title: `A relayed tool call of a real ${harness} turn, in flight at kill -9 of the Host, is settled as lost by the next Host and not sent again`,
  async run() {
    expect(ctx.state.os === 'Darwin', 'This verification uses the launchd service on a macOS VM.');
    const chatId = harness === 'claude' ? `claude:${crypto.randomUUID()}` : crypto.randomUUID();
    const word = `word-${crypto.randomUUID().slice(0, 8)}`;
    const tools = [
      {
        name: TOOL,
        description: 'Sends one short note to the person. Takes no arguments. Call it when asked to send a note.',
        inputSchema: { type: 'object', properties: {} },
        policy: 'act',
      },
    ];
    const c = await connect();
    const synced = await c.request('host.toolsSync', { tools });
    expect(synced.registered?.includes(TOOL), `The Host did not take the tool: ${JSON.stringify(synced)}`);
    await c.request('chat.subscribe', { chatId, epoch: 1 });
    await c.request('chat.start', {
      chatId,
      epoch: 1,
      harness,
      key: crypto.randomUUID(),
      text: `The code word of this conversation is ${word}. Send me a note now: call the ${TOOL} tool exactly once, with no arguments, and use no other tool. After it answers, say "ended".`,
      cwd: ctx.state.dataDir,
    });
    // the app's side of the relay: the call arrives and is never answered
    const asked = await c.waitFor((/** @type {any} */ e) => e.event === 'tool' && e.chatId === chatId && e.name === TOOL, 180_000);
    const turnId = frames(c, chatId)
      .map((/** @type {any} */ f) => f.item?.event)
      .find((/** @type {any} */ e) => e?.kind === 'turnStart')?.turnId;
    expect(turnId, 'The turn did not start on the stream.');
    // a browser action left unanswered too, where this Host has a browser: a navigation to an address that never answers
    let browser = 'not run: this Host has no browser ready';
    const tab = await c
      .request('browser.open', { chatId, epoch: 1 })
      .catch((/** @type {any} */ e) => ({ refused: String(e?.code ?? e?.message) }));
    if (tab.targetId) {
      await c.request('browser.attach', { chatId, epoch: 1, targetId: tab.targetId });
      c.request('browser.command', {
        chatId,
        epoch: 1,
        targetId: tab.targetId,
        sessionId: '',
        method: 'Page.navigate',
        params: { url: 'http://10.255.255.1/' },
      }).catch(() => undefined);
      browser = 'sent';
    } else browser = `not run: ${tab.refused ?? 'no tab'}`;
    const calls = await until(
      async () => {
        const found = await ctx.m.run(`cat '${path.join(ctx.state.dataDir, 'calls.json')}'`);
        const names = found.code === 0 ? Object.values(JSON.parse(found.stdout)).map((/** @type {any} */ v) => `${v.kind} ${v.name}`) : [];
        return names.includes(`tool ${TOOL}`) && (browser !== 'sent' || names.includes('browser navigation')) ? names : null;
      },
      { what: 'the calls on disk before the kill', ms: 30_000 },
    ).catch(async () => {
      // the navigation may have been answered at once (an address this network refuses): the tool call alone is then what is in flight
      const found = await ctx.m.run(`cat '${path.join(ctx.state.dataDir, 'calls.json')}'`);
      const names = Object.values(JSON.parse(found.stdout)).map((/** @type {any} */ v) => `${v.kind} ${v.name}`);
      expect(names.includes(`tool ${TOOL}`), `The relayed call is not on disk before the kill: ${found.stdout.slice(0, 300)}`);
      browser = `${browser}, but not in flight at the kill`;
      return names;
    });
    const oldPid = await pid();
    const killed = await ctx.m.run(`kill -9 ${oldPid}`);
    expect(killed.code === 0, 'Could not kill the verified Host PID.');
    const newPid = await until(
      async () => {
        const current = await pid();
        return current !== oldPid ? current : null;
      },
      { what: 'a different launchd Host PID' },
    );
    const again = await until(async () => connect().catch(() => null), {
      what: 'the replacement Host accepting authenticated hello',
      ms: 60_000,
    });
    // the app comes back as it would: its tools announced, the chat subscribed (so its calls would come here)
    await again.request('host.toolsSync', { tools });
    await again.request('chat.subscribe', { chatId, epoch: 1 });
    const items = () =>
      frames(again, chatId).flatMap((/** @type {any} */ f) =>
        f.t === 'hello' ? (f.snapshot?.items ?? []) : f.t === 'durable' ? [f.item] : [],
      );
    const ofTurn = () => items().filter((/** @type {any} */ i) => i?.event?.turnId === turnId || i?.turnId === turnId);
    fs.writeFileSync(path.join(evidence, 'turn-items.json'), JSON.stringify(ofTurn(), null, 2));
    const end = ofTurn()
      .map((/** @type {any} */ i) => i.event)
      .find((/** @type {any} */ e) => e?.kind === 'turnEnd');
    expect(end, 'The replacement Host did not end the turn it found running.');
    expect(
      end.stopReason === 'cancelled' && end.interrupted?.by === 'host_restart',
      `The turn's end does not say the restart cut it off: ${JSON.stringify(end).slice(0, 300)}`,
    );
    const lost = (end.interrupted.lost ?? []).map((/** @type {any} */ l) => `${l.kind} ${l.name}`);
    expect(lost.includes(`tool ${TOOL}`), `The end does not name the relayed call as lost: ${JSON.stringify(end.interrupted)}`);
    expect(
      !calls.includes('browser navigation') || lost.includes('browser navigation'),
      `The navigation was on disk at the kill and is not named as lost: ${JSON.stringify(end.interrupted)}`,
    );
    // every card of the turn is closed: none is left running for a client that opens the chat later
    /** @type {Map<string, string>} */
    const status = new Map();
    for (const item of ofTurn()) {
      const update = item?.event?.update;
      if (typeof update?.toolCallId === 'string' && update.status) status.set(update.toolCallId, update.status);
    }
    const running = [...status].filter(([, s]) => s !== 'completed' && s !== 'failed');
    expect(running.length === 0, `Cards of the turn are still running after the restart: ${JSON.stringify(running)}`);
    const settled = ofTurn().filter((/** @type {any} */ i) => i?.event?.update?._meta?.mopilot?.settled === 'host_restart').length;
    // never sent again: the replacement Host has the app and the chat, and sends it no call it was not asked for
    const left = await ctx.m.run(`cat '${path.join(ctx.state.dataDir, 'calls.json')}'`);
    expect(
      left.code === 0 && left.stdout.trim() === '[]',
      `The replacement Host holds calls it did not send: ${left.stdout.slice(0, 200)}`,
    );
    await new Promise((r) => setTimeout(r, 10_000));
    expect(toolEvents(again, chatId).length === 0, 'The replacement Host sent the lost call to the app again.');
    // the chat carries on in the same native session, and still sends nothing by itself
    await again.request('chat.send', {
      chatId,
      epoch: 1,
      key: crypto.randomUUID(),
      text: 'What is the code word of this conversation, given in my first message? Reply with the word only. Do not use tools.',
      cwd: ctx.state.dataDir,
    });
    await until(
      async () => items().some((/** @type {any} */ i) => i?.t === 'assistant' && i.turnId !== turnId && (i.error || String(i.text).trim())),
      { what: 'the reply to the message after the restart', ms: 300_000, every: 1000 },
    );
    const reply = items().findLast((/** @type {any} */ i) => i?.t === 'assistant' && i.turnId !== turnId);
    expect(
      !reply.error && String(reply.text).includes(word),
      `The session did not carry on: ${String(reply.error ?? reply.text).slice(0, 300)}`,
    );
    expect(toolEvents(again, chatId).length === 0, 'A call reached the app in the turn after the restart, which was told to use no tools.');
    fs.writeFileSync(
      path.join(evidence, 'calls-after.json'),
      JSON.stringify({ oldPid, newPid, asked, calls, browser, end, settled, reply }, null, 2),
    );
    return `Killed PID ${oldPid} with ${JSON.stringify(calls)} on disk (browser: ${browser}); restarted PID ${newPid}; the turn ended naming ${JSON.stringify(lost)} as lost, ${settled} card(s) closed by the restart and none left running; no call was sent to the app again; the next message recalled the code word.`;
  },
};

let rows;
try {
  rows = await runSteps({ steps: [...STEPS.filter((s) => ['A1', 'A2', 'A3', 'A4', 'A5'].includes(s.id)), step], ctx });
} finally {
  if (ctx.state.dataDir) {
    const log = await ctx.m.run(`tail -c 65536 '${path.join(ctx.state.dataDir, 'host.log')}'`);
    fs.writeFileSync(path.join(evidence, 'host-before-cleanup.log'), log.stdout);
  }
  clients.forEach((c) => c.close());
  fs.writeFileSync(path.join(evidence, 'artifact.json'), JSON.stringify(ctx.state.bundle ?? {}, null, 2));
  await cleanup(ctx);
}
const report = formatReport({
  target: vm,
  rows,
  platform: ctx.state.platform,
  notVerified: [
    'The app half (the notice text; covered by unit tests); a desktop action in flight (unit tests only); the other harness unless --harness names it; ACP agents.',
    'Any OS other than the named macOS VM; no login/account/model changes or user app launch.',
  ],
});
fs.writeFileSync(path.join(evidence, 'report.md'), report);
process.stdout.write(report);
process.exitCode = exitCode(rows);
