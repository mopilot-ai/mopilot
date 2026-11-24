// The audit line of the action itself (host/src/momoServices/gate.mjs): once the gate lets a call that changes something run, its intent is on the disk before it runs and its outcome follows; a failure of a call that may have left the Host is uncertain, never "not sent" by default; a restart records an intent left open as uncertain; a plain read has no pair; and with no writable log the action does not run and a card is not burned.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../host/src/momoHome.mjs';
// @ts-ignore
import gateService from '../host/src/momoServices/gate.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
import { A, MOMO } from './support/host/momoMoveWorld.ts';
import { chat, world } from './support/host/momoCoreWorld.ts';

const read = { tool: 'momo_memory_search', effect: 'read' as const, scope: 'memory', args: {}, summary: 'Look in memory' };
const note = { tool: 'momo_notes', effect: 'notes' as const, scope: 'notes', args: { text: 'x' }, summary: 'Change a note' };
const send = {
  tool: 'gmail.send',
  effect: 'send' as const,
  scope: 'dana@example.com',
  args: { to: 'dana@example.com', body: 'Hi' },
  summary: 'Send a mail',
};

/** Every line the home's audit log gets, by kind and what it says (`audit()` is the real log). */
function watch(w: any, { failRun = false, failOutcome = false } = {}) {
  const lines: string[] = [];
  const runs = new Set<string>();
  const real = w.home.stores.bind(w.home);
  const flags = { failRun, failOutcome };
  w.home.stores = () => {
    const s = real();
    return (
      s && {
        ...s,
        audit: {
          intent: async (f: any) => {
            if (flags.failRun && f.action.startsWith('run ')) throw new Error('disk full');
            lines.push(`intent ${f.action} ${f.decision}`);
            const r = await s.audit.intent(f);
            if (f.action.startsWith('run ')) runs.add(r.id);
            return r;
          },
          outcome: (id: string, o: any) => {
            if (flags.failOutcome && runs.has(id)) return Promise.reject(new Error('disk full'));
            lines.push(`outcome ${o.result}`);
            return s.audit.outcome(id, o);
          },
          refusal: s.audit.refusal.bind(s.audit),
          settleUnfinished: s.audit.settleUnfinished.bind(s.audit),
          unfinished: s.audit.unfinished.bind(s.audit),
        },
      }
    );
  };
  return Object.assign(lines, { audit: () => real().audit, flags });
}
/** A call of `send` whose card was answered, ready to be spent. */
async function allowed(w: any, call: object = send) {
  const asked = await w.gate.run(chat(call), () => 1);
  assert.equal(asked.pending, true);
  await w.gate.answer(asked.card.id, 'allow', 'phone:abc', 'Phone');
  return asked.card.id as string;
}

test('a call that changes something has its own intent line before it runs and its outcome after; a plain read has neither', async (t) => {
  const w = await world(t);
  const lines = watch(w);
  const seen: string[][] = [];
  assert.deepEqual(await w.gate.run(chat(note), () => (seen.push([...lines]), 7)), { done: true, result: 7 });
  assert.ok(
    seen[0].some((l) => l.startsWith('intent run momo_notes')),
    'the intent was on the disk when the action started',
  );
  assert.equal(lines.at(-1), 'outcome done');
  const before = lines.length;
  assert.deepEqual(await w.gate.run(chat(read), () => 8), { done: true, result: 8 });
  assert.deepEqual(
    lines.slice(before).filter((l) => l.startsWith('intent run')),
    [],
    'no run line for a read',
  );
  assert.equal((await lines.audit().verify()).ok, true);
});

test('a failure is not sent for a local change, and uncertain for anything that may have left the Host unless the error says it did not', async (t) => {
  const w = await world(t);
  const lines = watch(w);
  const boom =
    (extra: object = {}) =>
    () => {
      throw Object.assign(new Error('timed out'), extra);
    };
  const local = await w.gate.run(chat(note), boom());
  assert.equal(local.failed, true);
  assert.equal(lines.at(-1), 'outcome not sent');
  assert.equal(local.uncertain, false);
  // a send: a timeout after the request left is uncertain, and the model is told it may have happened
  const id = await allowed(w);
  const sent = await w.gate.resume(id, chat(send), boom());
  assert.equal(sent.uncertain, true);
  assert.equal(lines.at(-1), 'outcome uncertain');
  assert.match(sent.error, /may already have happened/);
  // an error that says it positively never left is not sent
  const again = await allowed(w, { ...send, args: { to: 'z@example.com' }, scope: 'z@example.com' });
  const clean = await w.gate.resume(
    again,
    chat({ ...send, args: { to: 'z@example.com' }, scope: 'z@example.com' }),
    boom({ notSent: true }),
  );
  assert.equal(clean.uncertain, false);
  assert.equal(lines.at(-1), 'outcome not sent');
  // a read that sends text out is a send for this
  const egress = await w.gate.run(chat({ ...read, egress: 'network' as const }), boom());
  assert.equal(egress.uncertain, true);
  // an error that says uncertain is uncertain whatever it did
  const marked = await w.gate.run(chat(note), boom({ uncertain: true }));
  assert.equal(marked.uncertain, true);
});

test('the run line carries the decision’s arguments’ digest and the card it spent', async (t) => {
  const w = await world(t);
  const lines = watch(w);
  const id = await allowed(w);
  assert.deepEqual(await w.gate.resume(id, chat(send), () => 1), { done: true, result: 1 });
  assert.ok(lines.includes(`intent run gmail.send card ${id}`));
});

test('with no writable log an action does not run, and a card is not burned: once the log works the same answered card runs once', async (t) => {
  const w = await world(t);
  const lines = watch(w);
  let ran = 0;
  lines.flags.failRun = true;
  assert.deepEqual(await w.gate.run(chat(note), () => ++ran), { refused: true, reason: 'audit_unavailable' });
  const id = await allowed(w);
  assert.deepEqual(await w.gate.resume(id, chat(send), () => ++ran), { refused: true, reason: 'audit_unavailable' });
  assert.equal(ran, 0);
  assert.equal((await w.gate.card(id)).status, 'allowed', 'the card is still waiting to be spent');
  lines.flags.failRun = false;
  assert.deepEqual(await w.gate.resume(id, chat(send), () => ++ran), { done: true, result: 1 });
  assert.deepEqual(await w.gate.resume(id, chat(send), () => ++ran), { refused: true, reason: 'used' });
  assert.equal(ran, 1);
});

test('a card that cannot be spent ends its intent as not sent', async (t) => {
  const w = await world(t);
  const lines = watch(w);
  const id = await allowed(w);
  assert.deepEqual(await w.gate.resume(id, chat({ ...send, args: { to: 'other@example.com' } }), () => 1), {
    refused: true,
    reason: 'mismatch',
  });
  assert.equal(lines.at(-1), 'outcome not sent');
});

test('an outcome that cannot be written leaves the intent open; a restart of the Host records it as uncertain, says so, and puts one row in MoMo’s chat, once', async (t) => {
  const w = await world(t);
  watch(w, { failOutcome: true });
  assert.deepEqual(await w.gate.run(chat(note), () => 3), { done: true, result: 3 }, 'what the action did stands');
  const dataKeyDir = path.join(w.dir, 'config', 'momo');
  await w.home.close();
  /** The same folders, a new process: the audit log finds an intent with no outcome. */
  const restart = async (rows: any) => {
    const reports: string[] = [];
    const home: any = createMomoHome({
      hostId: A.homeId,
      dataDir: path.join(w.dir, 'data'),
      safeStorage: createFileSafeStorage(path.join(w.dir, 'config')),
      dataSafeStorage: createFileSafeStorage(dataKeyDir),
      dataKeyDir,
      isMomoChat: (c: string) => c === 'momo-chat',
      report: () => undefined,
    });
    t.after(() => home.close());
    await home.grant({ account: 'a1', features: MOMO });
    home.rows = rows;
    gateService({ home, now: () => Date.now(), report: (m: string) => reports.push(m) });
    await home.start(A);
    for (const end = Date.now() + 3000; !reports.length && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
    return { home, reports };
  };
  // MoMo has no chat yet: the row is kept and posted when there is one (the sweep tries again)
  const puts = [] as any[];
  let chatThere = false;
  const rows = {
    put: async (r: any) => {
      if (!chatThere) throw new Error('no chat');
      puts.push(r);
    },
  };
  const first = await restart(rows);
  assert.match(first.reports[0], /1 MoMo action was cut short/);
  assert.deepEqual(await first.home.stores().audit.unfinished(), []);
  assert.equal((await first.home.stores().audit.verify()).ok, true);
  assert.equal(puts.length, 0);
  chatThere = true;
  await first.home.service('gate').sweep();
  assert.equal(puts.length, 1);
  assert.match(puts[0].id, /^cutshort:/);
  assert.equal(puts[0].kind, 'result');
  assert.match(puts[0].result.title, /^momo_notes was cut short$/);
  assert.match(puts[0].result.summary, /may or may not have happened; MoMo did not try again/);
  assert.ok(!JSON.stringify(puts[0]).includes('"x"'), 'nothing the action carried');
  await first.home.service('gate').sweep();
  assert.equal(puts.length, 1, 'posted once');
  // a second restart finds nothing cut short and posts nothing more
  await first.home.close();
  const second = await restart(rows);
  await second.home.service('gate').sweep();
  assert.equal(puts.length, 1);
  assert.deepEqual(second.reports, []);
});

test('with no audit log at all nothing runs, and the gate says why instead of carrying on', async (t) => {
  const w = await world(t);
  const real = w.home.stores.bind(w.home);
  w.home.stores = () => {
    const s = real();
    return s && { ...s, audit: undefined };
  };
  let ran = 0;
  await assert.rejects(
    w.gate.run(chat(note), () => ++ran),
    /audit log is not available/,
  );
  await assert.rejects(
    w.gate.run(chat(read), () => ++ran),
    /audit log is not available/,
  );
  assert.equal(ran, 0);
});

test('an audit log whose open intents cannot be read does not stop the gate from building: it says so, and every action still has its own intent line', async (t) => {
  const reports: string[] = [];
  const w = await world(t, { report: (m: string) => reports.push(m) });
  const real = w.home.stores.bind(w.home);
  w.home.stores = () => {
    const s = real();
    return (
      s && {
        ...s,
        audit: {
          intent: s.audit.intent.bind(s.audit),
          outcome: s.audit.outcome.bind(s.audit),
          refusal: s.audit.refusal.bind(s.audit),
          unfinished: () => Promise.reject(new Error('unreadable')),
        },
      }
    );
  };
  assert.deepEqual(await w.gate.run(chat(note), () => 5), { done: true, result: 5 });
  assert.ok(reports.some((m) => /audit log could not be read for actions a stop cut short: unreadable/.test(m)));
});

test('two actions cut short are one report in the plural, and a row made while the home is no longer running still names a machine', async (t) => {
  const w = await world(t);
  watch(w, { failOutcome: true });
  assert.deepEqual(await w.gate.run(chat(note), () => 1), { done: true, result: 1 });
  assert.deepEqual(await w.gate.run(chat({ ...note, args: { text: 'y' } }), () => 2), { done: true, result: 2 });
  const dataKeyDir = path.join(w.dir, 'config', 'momo');
  await w.home.close();
  const reports: string[] = [];
  const home: any = createMomoHome({
    hostId: A.homeId,
    dataDir: path.join(w.dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(w.dir, 'config')),
    dataSafeStorage: createFileSafeStorage(dataKeyDir),
    dataKeyDir,
    isMomoChat: (c: string) => c === 'momo-chat',
    report: () => undefined,
  });
  t.after(() => home.close());
  await home.grant({ account: 'a1', features: MOMO });
  const rows: any[] = [];
  home.rows = { put: async (r: any) => void rows.push(r) };
  // the home stops running just after the open intents are read, once
  const realStores = home.stores.bind(home);
  const realStamp = home.stamp.bind(home);
  let gone = false;
  // only the gate's own build is told so: another service's timer reading the stamp first must not use the one null up
  home.stamp = () => (gone && /\bbuild \(.*momoServices\/gate\.mjs/.test(new Error().stack ?? '') ? ((gone = false), null) : realStamp());
  home.stores = () => {
    const s = realStores();
    const audit = new Proxy(s.audit, {
      get: (target: any, key) =>
        key === 'unfinished'
          ? async () => ((gone = true), target.unfinished())
          : typeof target[key] === 'function'
            ? target[key].bind(target)
            : target[key],
    });
    return s && { ...s, audit };
  };
  gateService({ home, now: () => Date.now(), report: (m: string) => reports.push(m) });
  await home.start(A);
  for (const end = Date.now() + 3000; !reports.length && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
  assert.match(reports[0], /2 MoMo actions were cut short/);
  await home.service('gate').sweep();
  const cut = rows.filter((r) => String(r.id).startsWith('cutshort:') && r.id !== 'cutshort:seed');
  assert.equal(new Set(cut.map((r) => r.id)).size, 2, JSON.stringify(rows.map((r) => r.id)));
  assert.ok(
    cut.every((r) => r.result.machine.machineId === 'this-machine'),
    'with no home to name, the row says this machine',
  );
});
