// The M4 and M6 milestone steps of the Host acceptance run (scripts/host-accept/milestones/m4.mjs, m6.mjs, policyFile.mjs): a managed policy file that caps permission, the audit record of an answered approval, and a day spend limit, against a stand-in machine and Host that keep the policy, the card, the audit lines and the spend as the real ones do on the wire (W: a step that fails, I: the stand-in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSteps } from '../scripts/host-accept.mjs';
import { MILESTONES } from '../scripts/host-accept/milestones/index.mjs';
import { policyFileOf, removePolicyFile } from '../scripts/host-accept/milestones/policyFile.mjs';

type Opts = {
  noSudo?: boolean;
  writeFails?: boolean;
  /** which part of the cap the stand-in Host does not keep */
  broken?: 'start' | 'keep' | 'switch' | 'lock';
  /** a refused file takes the last good cap with it */
  dropsCap?: boolean;
  /** the cap stays after the file is gone */
  stuck?: boolean;
  noLine?: boolean;
  anonymous?: boolean;
  decision?: string;
  late?: boolean;
  chain?: boolean;
  leak?: boolean;
  badStop?: boolean;
  noLimit?: boolean;
  badReply?: boolean;
  darwin?: boolean;
  psFails?: boolean;
  exportFails?: boolean;
};

const RANK = ['read-only', 'default', 'auto-review', 'full-access'];

/** A machine with a Host that reads a policy file, keeps a card and an audit record, and totals spend. */
function machine(o: Opts = {}) {
  const s = {
    pid: '1000',
    file: null as null | { owner: 'root' | 'user'; doc: any },
    good: false,
    spent: 0,
    limit: null as number | null,
    cards: new Map<string, any>(),
    audit: [] as any[],
    commands: [] as string[],
    policies: [] as any[],
  };
  const conns: any[] = [];
  const emit = (chatId: string, item: object) =>
    conns
      .filter((c) => c.subs.has(chatId))
      .forEach((c) => setImmediate(() => c.push(`${JSON.stringify({ event: 'frame', chatId, frame: { item } })}\n`)));
  const live = () => {
    if (s.file?.owner === 'root') s.good = true;
    return Boolean(s.file) && (s.file?.owner === 'root' || (s.good && !o.dropsCap));
  };
  const cap = () => live() || Boolean(o.stuck);
  const reply = (chatId: string, text: string) =>
    emit(chatId, { t: 'assistant', text: `fake-acp: ${text}`, stopReason: o.badStop ? 'refusal' : 'end_turn' });
  const policyBlock = () => ({
    managed: live(),
    locked: live() && o.broken !== 'lock' ? ['permissionMax'] : [],
    ...(s.file?.owner === 'user' ? { problem: 'The managed policy file is not owned by root, so it was ignored.' } : {}),
  });
  const refused = (code: string, message: string) => ({ error: message, code });
  const handle = (method: string, p: any, conn: any) => {
    if (method === 'status') return { result: { policy: policyBlock(), spend: { dayUsd: s.spent, dayLimitUsd: s.limit, unpriced: 0 } } };
    if (method === 'host.hello') return { result: { agreed: true } };
    if (method === 'host.policy') return s.policies.push(p.doc), (s.limit = p.doc.spend?.dayUsd ?? null), { result: { generation: 'g' } };
    if (method === 'chat.permit') {
      if (cap() && RANK.indexOf(p.value) > 1 && o.broken !== 'switch') return refused('policy_refused', 'no');
      return { result: { permission: p.value } };
    }
    if (method === 'chat.subscribe') return conn.subs.add(p.chatId), { result: {} };
    if (method === 'host.pending') return { result: { cards: [...s.cards.values()], attention: [] } };
    if (method === 'chat.send') {
      if (s.limit !== null && s.spent >= s.limit && !o.noLimit) return refused('spend_limit', 'over');
      reply(p.chatId, o.badReply ? 'something else' : p.text);
      return { result: { turnId: 't2' } };
    }
    if (method === 'chat.start') {
      const high = p.permission && RANK.indexOf(p.permission) > 1;
      if (high && cap() && !(o.broken === 'start' && p.chatId.includes('accept21'))) return refused('policy_refused', 'no');
      if (p.permission && !high && o.broken === 'keep') return refused('policy_refused', 'no');
      if (p.text.startsWith('PERMIT'))
        s.cards.set(p.chatId, {
          chatId: p.chatId,
          epoch: 1,
          requestId: `r-${p.chatId}`,
          family: 'acp',
          cardKind: 'permission',
          summary: { tool: 'edit', line: 'Fake action text' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow' },
            { optionId: 'reject', name: 'Reject', kind: 'deny' },
          ],
          at: 1,
        });
      if (p.text.startsWith('SPEND')) {
        s.spent += 0.06;
        reply(p.chatId, p.text);
      }
      return { result: { turnId: 't1' } };
    }
    if (method === 'chat.answer') {
      s.cards.delete(p.chatId);
      if (!o.noLine)
        s.audit.push({
          kind: 'approval.answered',
          chat: p.chatId,
          at: Date.now() + (o.late ? 3_600_000 : 0),
          ...(o.anonymous ? {} : { by: { fingerprint: 'abcdef0123456789abcdef', name: 'Mac', kind: 'desktop' } }),
          what: { decision: o.decision ?? 'allow' },
        });
      emit(p.chatId, { t: 'event', event: { kind: 'turnEnd', stopReason: 'end_turn' } });
      return { result: { answered: true } };
    }
    return { error: `unexpected ${method}` };
  };
  return {
    state: s,
    async run(command: string, input?: Buffer) {
      s.commands.push(command);
      const out = (stdout = '', code = 0, stderr = '') => ({ code, stdout, stderr });
      if (command === 'sudo -n true') return out('', o.noSudo ? 1 : 0);
      if (command.includes('sudo -n tee')) {
        if (o.writeFails) return out('', 1, 'denied');
        s.file = { owner: command.includes('chown root:') ? 'root' : 'user', doc: JSON.parse(String(input)) };
        return out();
      }
      if (command.startsWith('sudo -n rm -f')) return (s.file = null), (s.good = false), out();
      if (command.includes('launchctl kickstart') || command.includes('systemctl --user restart'))
        return (s.pid = String(Number(s.pid) + 1)), out();
      if (command.includes('[m]opilot-host.mjs serve')) return out(s.pid);
      if (command.startsWith('ps -o args=')) return o.psFails ? out('node') : out('node /h/mopilot-host.mjs serve --data-dir /d');
      if (command.includes('audit export') && command.endsWith('--verify'))
        return o.chain ? out('The chain breaks at line 2.', 2) : out(`The chain holds for ${s.audit.length} lines.`);
      if (command.includes('audit export')) return o.exportFails ? out('', 1, 'no') : out(s.audit.map((l) => JSON.stringify(l)).join('\n'));
      if (command === 'date +%s') return out(String(Math.floor(Date.now() / 1000)));
      if (command.startsWith('grep -rlF')) return out(o.leak ? '/d/audit/day.jsonl' : '');
      return out();
    },
    open() {
      const conn: any = { subs: new Set<string>(), push: (_: string) => undefined, end: () => undefined };
      conns.push(conn);
      return {
        write(line: string) {
          const { id, method, params } = JSON.parse(line);
          setImmediate(() => conn.push(`${JSON.stringify({ id, ...handle(method, params, conn) })}\n`));
        },
        onData: (fn: (c: string) => void) => (conn.push = fn),
        kill: () => conn.end(),
        closed: new Promise<void>((r) => (conn.end = r)),
      };
    },
  };
}

const ctxFor = (m: any, os = 'Linux') => ({
  m,
  deps: { authenticate: async () => undefined, helloParams: () => ({}) },
  state: { socket: '/s', identity: {}, dataDir: '/d', pid: '1000', os, policyFile: '' },
  nonce: 'n',
  opts: { waitPauseMin: 0, harness: '' },
});
const all = [...MILESTONES.M4, ...MILESTONES.M6];
const rowsOf = (ctx: any, ids: string[]) => runSteps({ steps: ids.map((id) => all.find((s) => s.id === id)!) as any, ctx });
const M6 = ['S5a', 'S5b', 'S5c', 'S6'];
const statuses = (rows: any[]) => rows.map((r) => r.status);

test('I: M6: the cap holds, a writable file is refused and reported, removal lifts it, and the approval is audited', {
  timeout: 60_000,
}, async () => {
  const m = machine();
  const ctx = ctxFor(m);
  const rows = await rowsOf(ctx, M6);
  assert.deepEqual(statuses(rows), ['PASS', 'PASS', 'PASS', 'PASS'], JSON.stringify(rows));
  assert.match(rows[0].detail, /root-owned.*locked permissionMax.*Full access refused on start and on switch/);
  assert.match(rows[1].detail, /not owned by root.*last good file still refuses/);
  assert.match(rows[3].detail, /approval\.answered by Mac \(desktop, abcdef012345….*chain holds for 1 lines/);
  assert.deepEqual(m.state.policies, []);
  assert.equal(m.state.file, null);
  assert.equal(ctx.state.policyFile, '');
  assert.ok(m.state.commands.some((c) => c.includes("'/etc/mopilot-host/managed-policy.json'") && c.includes('chown root:root')));
  assert.equal(m.state.pid, '1001');
});

test('A: the file is where the Host reads it on each OS, and a run without it removes nothing', async () => {
  assert.equal(policyFileOf(ctxFor(machine(), 'Darwin')), '/Library/Application Support/MoPilot Host/managed-policy.json');
  assert.equal(policyFileOf(ctxFor(machine())), '/etc/mopilot-host/managed-policy.json');
  const m = machine();
  await removePolicyFile(ctxFor(m));
  assert.deepEqual(m.state.commands, []);
  const mac = machine();
  const ctx = ctxFor(mac, 'Darwin');
  await rowsOf(ctx, ['S5a']);
  assert.ok(mac.state.commands.some((c) => c.includes('chown root:wheel') && c.includes('MoPilot Host')));
  await removePolicyFile(ctx);
  assert.equal(mac.state.file, null);
});

test('A: without sudo -n the policy steps are SKIP rows that say why, and nothing is written', async () => {
  const m = machine({ noSudo: true });
  const rows = await rowsOf(ctxFor(m), M6.slice(0, 3));
  assert.deepEqual(statuses(rows), ['SKIP', 'SKIP', 'SKIP']);
  assert.match(rows[0].detail, /sudo -n is not allowed.*never prompts/);
  assert.match(rows[1].detail, /S5a was skipped/);
  assert.match(rows[2].detail, /S5a was skipped/);
  assert.equal(m.state.file, null);
});

test('W: S5 fails with why: a file that cannot be written, a cap or lock the Host does not keep', { timeout: 120_000 }, async () => {
  const detail = async (o: Opts, ids = ['S5a']) => (await rowsOf(ctxFor(machine(o)), ids)).at(-1)!;
  assert.match((await detail({ writeFails: true })).detail, /could not be written \(denied\)/);
  assert.match((await detail({ broken: 'lock' })).detail, /does not report the lock/);
  assert.match((await detail({ broken: 'start' })).detail, /chat\.start with Full access got "null"/);
  assert.match((await detail({ broken: 'keep' })).detail, /with Ask for approval was refused too/);
  assert.match((await detail({ broken: 'switch' })).detail, /switch to Full access got "null"/);
  assert.match((await detail({ dropsCap: true }, ['S5a', 'S5b'])).detail, /last good cap must hold/);
  assert.match((await detail({ stuck: true }, ['S5a', 'S5b', 'S5c'])).detail, /Full access is still refused after the file went/);
});

test('W: S6 fails with why: no line, nobody named, the wrong decision, a time far off, a broken chain, leaked text', {
  timeout: 60_000,
}, async () => {
  const detail = async (o: Opts) => (await rowsOf(ctxFor(machine(o)), ['S6']))[0];
  assert.match((await detail({ noLine: true })).detail, /No approval\.answered line names/);
  assert.match((await detail({ anonymous: true })).detail, /does not name who answered/);
  assert.match((await detail({ decision: 'deny' })).detail, /decision was "deny"/);
  assert.match((await detail({ late: true })).detail, /is not near the answer/);
  assert.match((await detail({ chain: true })).detail, /chain did not verify: The chain breaks/);
  assert.match((await detail({ leak: true })).detail, /audit folder holds the text/);
  assert.match((await detail({ psFails: true })).detail, /command line could not be read/);
  assert.match((await detail({ exportFails: true })).detail, /audit export exited 1/);
});

test('I: M4/S10: the crossing turn finishes, the next message is held with spend_limit, and the same key goes once the limit is raised', {
  timeout: 60_000,
}, async () => {
  const m = machine();
  const [row] = await rowsOf(ctxFor(m), ['S10']);
  assert.equal(row.status, 'PASS', JSON.stringify(row));
  assert.match(row.detail, /ended end_turn at \$0\.06 of \$0\.05.*spend_limit.*same key.*\$100/);
  assert.deepEqual(m.state.policies, [{ version: 1, spend: { dayUsd: 0.05 } }, { version: 1, spend: { dayUsd: 100 } }, { version: 1 }]);
});

test('W: S10 fails with why: a crossing turn that does not end, a limit that does not hold, a message that does not go', {
  timeout: 60_000,
}, async () => {
  const detail = async (o: Opts) => (await rowsOf(ctxFor(machine(o)), ['S10']))[0];
  assert.match((await detail({ badStop: true })).detail, /crossing turn ended with refusal/);
  assert.match((await detail({ noLimit: true })).detail, /over the limit got "null"/);
  assert.match((await detail({ badReply: true })).detail, /released turn said "fake-acp: something else"/);
});
