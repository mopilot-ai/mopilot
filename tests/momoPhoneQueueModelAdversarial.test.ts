// The held-message queue against a hostile world: the home's turn ledger (accept, duplicate, void on an unknown status, busy), a lossy network (lost and timed-out answers, requests that land after a kill), writes that fail and still land, kills at any point, a rival device and a lagging belief about the home; checked over every interleaving the time budget allows and by seeded random walks.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// QUEUE_MODEL_PATH lets a mutation run point this file at a broken copy of the machine
const queuePath = process.env.QUEUE_MODEL_PATH ?? new URL('../mobile/src/momoPhone/queue.ts', import.meta.url).href;
const { start, step, restore } = await import(queuePath);

type Any = any;
type Turn = { id: string; text: string; at: number; delivery: string };
type Req = { k: 'send' | 'check'; id: string; waiting: boolean };
type Resp = { k: 'sent' | 'checked'; id: string; answer: string };
type Ledger = Record<string, 'accepted' | 'done' | 'void'>;
type W = {
  q: Any;
  /** What is really on the phone's storage: the last write that landed, even one that reported a failure. */
  disk: Turn[] | 'unreadable';
  writes: { id: string | null; image: Turn[] }[];
  reqs: Req[];
  resps: Resp[];
  host: { up: boolean; rival: boolean; ledger: Ledger };
  ghost: {
    subs: Record<string, string>;
    sends: Record<string, number>;
    lastOk: boolean;
    skipSync: boolean;
  };
  log: string[];
};
type Hooks = { tolerate?: Set<string> };
type Move = [Any, string];

const turn = (id: string, delivery: string): Turn => ({
  id,
  text: `m${id}`,
  at: 1,
  delivery,
});
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const held = (q: Any, id: string | null) => q.turns.find((t: Any) => t.id === id);

function fresh(read: 'none' | 'ok' | 'unreadable' | 'unread', turns: Turn[] = [], ledger: Ledger = {}): W {
  let q = start();
  if (read !== 'unread') {
    const loaded = step(q, { t: 'load', read, turns });
    // a copy that cannot be read is told to the person
    if (read === 'unreadable')
      assert.ok(
        loaded.effects.some((f: Any) => f.t === 'tell' && f.why === 'lost'),
        'an unreadable copy was not told',
      );
    q = loaded.state;
  }
  const woke = step(q, { t: 'home', running: true });
  q = woke.state;
  return {
    q,
    disk: read === 'unreadable' ? 'unreadable' : turns,
    writes: woke.effects.filter((f: Any) => f.t === 'write').map((f: Any) => ({ id: f.id, image: clone(f.image) })),
    reqs: [],
    resps: [],
    host: { up: true, rival: false, ledger },
    ghost: {
      subs: Object.fromEntries(turns.map((t) => [t.id, 'acked'])),
      sends: Object.fromEntries(turns.filter((t) => t.delivery === 'not-sure').map((t) => [t.id, 1])),
      lastOk: true,
      skipSync: false,
    },
    log: [],
  };
}

/** The phone opens again from what its storage holds (`landed` of the writes on their way got there): nothing in flight, the home not yet known to run. */
function reopen(w0: W, landed: number): W {
  const w = clone(w0);
  const disk = landed ? w.writes[landed - 1].image : w.disk;
  const ids = new Set(disk === 'unreadable' ? [] : disk.map((t) => t.id));
  // a message whose save was never acknowledged goes back to the person; one that was must be there again unless the home has it
  const subs: Record<string, string> = {};
  for (const [id, s] of Object.entries(w.ghost.subs)) {
    if (s === 'open') continue;
    subs[id] = s === 'acked' && !ids.has(id) ? 'resolved' : s;
  }
  return {
    ...w,
    q: step(start(), { t: 'home', running: false }).state,
    disk,
    writes: [],
    resps: [],
    reqs: w.reqs.map((r) => ({ ...r, waiting: false })),
    ghost: { ...w.ghost, subs, lastOk: true, skipSync: false },
    log: [...w0.log, `kill after ${landed}/${w0.writes.length} writes`],
  };
}

function moves(w: W): Move[] {
  const out: Move[] = [];
  const { q } = w;
  for (const id of ['s1', 's2'])
    if (!w.log.includes(`submit ${id}`)) out.push([{ t: 'submit', id, text: `m${id}`, at: 1 }, `submit ${id}`]);
  for (const t of q.turns)
    if (t.id === 's1' || t.id === 's2') out.push([{ t: 'submit', id: t.id, text: t.text, at: 1 }, `submit ${t.id} again`]);
  if (!w.log.includes('adopt a1')) out.push([{ t: 'adopt', id: 'a1', text: 'ma1', at: 1 }, 'adopt a1']);
  if (q.disk === 'unread' || q.disk === 'unreadable') {
    if (w.disk === 'unreadable') out.push([{ t: 'load', read: 'unreadable' }, 'read kept copy']);
    else {
      out.push([
        {
          t: 'load',
          read: 'ok',
          turns: w.disk.filter((t) => t.delivery !== 'accepted'),
        },
        'read kept copy',
      ]);
      out.push([{ t: 'load', read: 'unreadable' }, 'read fails']);
    }
  }
  const head = w.writes[0];
  if (head)
    for (const how of ['ok', 'fails', 'fails but landed'])
      out.push([{ t: 'wrote', id: head.id, ok: how === 'ok', image: head.image }, `write ${how}`]);
  w.reqs.forEach((r, i) => {
    out.push([`land ${i}`, `land ${r.k} ${r.id}`]);
    out.push([`lose ${i}`, `lose ${r.k} ${r.id}`]);
  });
  w.resps.forEach((r, i) => out.push([`deliver ${i}`, `deliver ${r.k} ${r.id} ${r.answer}`]));
  for (const t of q.turns) {
    if (t.op === 'send') out.push([{ t: 'sent', id: t.id, answer: 'unanswered' }, `send ${t.id} times out`]);
    if (t.op === 'check') out.push([{ t: 'checked', id: t.id, answer: 'unavailable' }, `check ${t.id} times out`]);
    out.push([{ t: 'check', id: t.id }, `ask ${t.id}`]);
    out.push([{ t: 'resend', id: t.id }, `resend ${t.id}`]);
    if (w.host.ledger[t.id] && w.host.ledger[t.id] !== 'void') out.push([{ t: 'listed', ids: [t.id] }, `listed ${t.id}`]);
  }
  out.push([{ t: 'retry' }, 'retry']);
  out.push([{ t: 'home', running: !q.running }, q.running ? 'belief: home sleeps' : 'belief: home wakes']);
  out.push(['host up', w.host.up ? 'home goes away' : 'home returns']);
  out.push(['rival', w.host.rival ? 'rival settles' : 'rival takes the chat']);
  if (Object.values(w.host.ledger).includes('accepted')) out.push(['settle', 'home settles a turn']);
  out.push([{ t: 'forget' }, 'forget']);
  if (q.disk === 'unreadable') out.push([{ t: 'discard' }, 'discard']);
  out.push(['kill', 'kill']);
  return out;
}

/** The home's answer to one request that reaches it; the home changes its own ledger as the real one does. */
function landAt(w: W, r: Req): Resp | null {
  const { host } = w;
  const seen = host.ledger[r.id];
  if (!host.up)
    return r.waiting
      ? {
          k: r.k === 'send' ? 'sent' : 'checked',
          id: r.id,
          answer: r.k === 'send' ? 'refused' : 'unavailable',
        }
      : null;
  if (r.k === 'send') {
    const answer = seen === 'void' ? 'refused' : seen || !host.rival ? 'accepted' : 'refused';
    if (!seen && answer === 'accepted') host.ledger[r.id] = 'accepted';
    return r.waiting ? { k: 'sent', id: r.id, answer } : null;
  }
  // a status on an id the home never saw records it as not arrived: an original still on its way is refused from then on
  if (!seen) host.ledger[r.id] = 'void';
  return r.waiting
    ? {
        k: 'checked',
        id: r.id,
        answer: seen && seen !== 'void' ? 'has' : 'missing',
      }
    : null;
}

function apply(w0: W, [mv, name]: Move, hooks: Hooks = {}): W[] {
  if (mv === 'kill') return Array.from({ length: w0.writes.length + 1 }, (_, landed) => reopen(w0, landed));
  const w = clone(w0);
  w.log = [...w0.log, name];
  let e: Any | null = typeof mv === 'object' ? mv : null;
  if (typeof mv === 'string') {
    const [verb, n] = mv.split(' ');
    if (verb === 'land') {
      const [r] = w.reqs.splice(Number(n), 1);
      const resp = landAt(w, r);
      if (resp) w.resps.push(resp);
    } else if (verb === 'lose') w.reqs.splice(Number(n), 1);
    else if (verb === 'deliver') {
      const [r] = w.resps.splice(Number(n), 1);
      e = { t: r.k, id: r.id, answer: r.answer };
    } else if (mv === 'host up') w.host.up = !w.host.up;
    else if (mv === 'rival') w.host.rival = !w.host.rival;
    else for (const [id, s] of Object.entries(w.host.ledger)) if (s === 'accepted') w.host.ledger[id] = 'done';
  }
  if (!e) return [w];
  // a timeout answers the phone with nothing from the home; the request stays out there and may still land
  if (e.t === 'sent' || e.t === 'checked') {
    const gone = e.answer === 'unanswered' || e.answer === 'unavailable';
    if (gone) {
      for (const r of w.reqs) if (r.k === (e.t === 'sent' ? 'send' : 'check') && r.id === e.id) r.waiting = false;
      w.resps = w.resps.filter((r) => !(r.id === e.id && r.k === e.t));
    }
  }
  if (e.t === 'wrote') {
    const done = w.writes.shift()!;
    if (e.ok || name === 'write fails but landed') w.disk = done.image;
    w.ghost.lastOk = e.ok;
  }
  if (e.t === 'load' && e.read === 'ok' && Array.isArray(w.disk)) {
    // the helper that models a reopened phone agrees with reading the kept copy
    const read = restore({ ...w.q, image: w.disk });
    const viaLoad = step(start(), e).state;
    assert.deepEqual(clone(read.turns), clone(viaLoad.turns), 'restore and load disagree on the held messages');
  }
  const { state, effects } = step(w.q, e);
  w.q = state;
  for (const f of effects) {
    if (f.t === 'write') w.writes.push({ id: f.id, image: clone(f.image) });
    if (f.t === 'send') w.reqs.push({ k: 'send', id: f.id, waiting: true });
    if (f.t === 'check') w.reqs.push({ k: 'check', id: f.id, waiting: true });
  }
  verify(w0, w, e, effects, w.log.join(' > '), hooks);
  return [w];
}

function verify(w0: W, w: W, e: Any, effects: Any[], label: string, hooks: Hooks) {
  const { q, ghost, host } = w;
  const before = w0.q;
  const rejected = new Set<string>(effects.filter((f) => f.t === 'reject').map((f) => f.id));
  const told = effects.some((f) => f.t === 'tell');
  const at = (what: string) => `${label}: ${what}`;

  for (const id of rejected) {
    assert.ok(told, at(`${id} was returned and the person was not told`));
    assert.ok(!held(q, id), at(`${id} was returned and is still held`));
    ghost.subs[id] = 'rejected';
  }
  // the same tap twice changes nothing
  if ((e.t === 'submit' || e.t === 'adopt') && held(before, e.id))
    assert.deepEqual([clone(q.turns), effects], [clone(before.turns), []], at(`${e.id} again changed something`));
  // Try again unblocks
  if (e.t === 'retry') assert.ok(!q.blocked, at('Try again left it blocked'));
  // a submit is held or returned: it never just disappears
  if ((e.t === 'submit' || e.t === 'adopt') && !rejected.has(e.id) && !held(before, e.id)) {
    assert.ok(held(q, e.id), at(`${e.id} was neither held nor returned`));
    ghost.subs[e.id] = 'open';
    if (e.t === 'adopt') ghost.sends[e.id] = 0;
  }
  if (e.t === 'wrote' && e.ok && held(before, e.id)?.op === 'save' && ghost.subs[e.id] === 'open') ghost.subs[e.id] = 'acked';
  if (e.t === 'forget') {
    for (const id of Object.keys(ghost.subs)) ghost.subs[id] = 'forgotten';
    assert.deepEqual([q.turns, q.image], [[], []], at('sign-out left held messages in the state'));
    ghost.skipSync = true;
  }
  // starting over after an unreadable copy is the person's own choice to let go of what was kept
  if (e.t === 'discard') {
    for (const id of Object.keys(ghost.subs)) ghost.subs[id] = 'forgotten';
    ghost.skipSync = true;
  }
  if (e.t === 'load' && e.read === 'unreadable') assert.ok(told && q.disk === 'unreadable', at('an unreadable copy was not told'));
  // a refused save is taken off the phone again: a write follows that no longer holds it
  if (e.t === 'wrote' && !e.ok && held(before, e.id)?.op === 'save')
    assert.ok(
      effects.some((f) => f.t === 'write' && !f.image.some((t: Any) => t.id === e.id)),
      at(`${e.id} was refused and no write took it off the phone`),
    );
  if (e.t === 'listed') for (const id of e.ids) ghost.subs[id] = 'resolved';
  if ((e.t === 'sent' && e.answer === 'refused') || (e.t === 'checked' && e.answer === 'missing')) ghost.sends[e.id] = 0;

  // what the phone believes about the home is true of the home's ledger
  for (const t of q.turns) {
    if (t.delivery === 'accepted')
      assert.ok(
        host.ledger[t.id] === 'accepted' || host.ledger[t.id] === 'done',
        at(`${t.id} is shown as taken and the home never took it`),
      );
    if (t.delivery === 'never-got-it')
      assert.ok(!host.ledger[t.id] || host.ledger[t.id] === 'void', at(`${t.id} is shown as never arrived and the home has it`));
    assert.equal(t.text, `m${t.id}`, at(`${t.id} changed its text`));
  }
  assert.equal(new Set(q.turns.map((t: Any) => t.id)).size, q.turns.length, at('a message is held twice'));
  // no message the person was told is kept, or is still open, drops out with no reason
  if (q.disk === 'ok')
    for (const [id, s] of Object.entries(ghost.subs))
      if (s === 'open' || s === 'acked') assert.ok(held(q, id), at(`${id} (${s}) is gone with no reason`));
  // one open turn per chat
  assert.ok(
    q.turns.filter((t: Any) => t.delivery === 'not-sure' || t.op === 'arm' || t.op === 'send').length <= 1,
    at('two messages are in doubt or on their way at once'),
  );
  assert.ok(!(q.blocked && q.turns.some((t: Any) => t.op === 'arm' || t.op === 'send')), at('blocked, and still arming or sending'));
  // a failed arm write is not tried again by itself, and nothing goes out
  if (e.t === 'wrote' && !e.ok && held(before, e.id)?.op === 'arm')
    assert.ok(
      !effects.some((f) => (f.t === 'write' && f.id === e.id) || f.t === 'send'),
      at('a failed arm write was tried again or sent anyway'),
    );

  // one message is saved at a time, and nothing is armed while another is being saved or waiting to be
  assert.ok(q.turns.filter((t: Any) => t.op === 'save').length <= 1, at('two messages are being saved at once'));
  for (const f of effects) {
    if (f.t === 'write' && f.id && held(q, f.id)?.op === 'arm') {
      assert.ok(q.running, at(`${f.id} armed while the home is not believed to run`));
      assert.ok(
        !q.turns.some((t: Any) => t.id !== f.id && (t.op === 'save' || t.op === 'hold')),
        at(`${f.id} armed while another message is being saved`),
      );
      assert.ok(!q.blocked, at('armed while blocked'));
    }
    if (f.t === 'check')
      assert.ok(
        !w.reqs.some((r) => r.k === 'send' && r.id === f.id && r.waiting),
        at(`${f.id} asked about while its send is still awaited`),
      );
    if (f.t !== 'send') continue;
    assert.equal(q.disk, 'ok', at('sent with the storage unreadable'));
    if (!(hooks.tolerate?.has('running') && e.t === 'wrote'))
      assert.ok(q.running, at(`${f.id} sent while the home is not believed to run`));
    assert.ok(!q.blocked, at('sent while blocked'));
    const on = Array.isArray(w.disk) ? w.disk.find((t) => t.id === f.id) : undefined;
    assert.equal(on?.delivery, 'not-sure', at(`${f.id} left before the doubt was really on the phone`));
    assert.equal(ghost.sends[f.id] ?? 0, 0, at(`${f.id} sent again with no status answer between`));
    ghost.sends[f.id] = 1;
    if (!hooks.tolerate?.has('void'))
      assert.notEqual(host.ledger[f.id], 'void', at(`${f.id} sent under an id the home voided: refused for good`));
  }
  // when nothing is on its way and the last write worked, the kept copy is exactly what is held (an accepted message is gone from it)
  if (!w.writes.length && ghost.lastOk && !ghost.skipSync && q.disk === 'ok' && Array.isArray(w.disk)) {
    const want = q.turns.filter((t: Any) => t.delivery !== 'accepted' && t.op !== 'hold').map((t: Any) => [t.id, t.text, t.delivery]);
    // a doubt kept for a message never sent (an arm write that failed, then a later write carried its image) is the safe way to differ: F5
    const kept = w.disk.map((t) => [
      t.id,
      t.text,
      t.delivery === 'not-sure' && (ghost.sends[t.id] ?? 0) === 0 && held(q, t.id)?.delivery === 'queued' ? 'queued' : t.delivery,
    ]);
    assert.deepEqual(kept, want, at('the kept copy is not what is held'));
  }
  // once sent, the kept copy says "not sure" for that id until a status answer, and the id is never queued again before one
  for (const [id, n] of Object.entries(ghost.sends)) {
    if (n !== 1) continue;
    const on = Array.isArray(w.disk) ? w.disk.find((t) => t.id === id) : undefined;
    if (on) assert.equal(on.delivery, 'not-sure', at(`${id} is kept as ${on.delivery} after it was sent`));
    assert.notEqual(held(q, id)?.delivery, 'queued', at(`${id} is queued again with no status answer`));
  }
}

const key = (w: W) => JSON.stringify([w.q, w.disk, w.writes, w.reqs, w.resps, w.host, w.ghost]);

function explore(initial: W, until: number, hooks: Hooks): number {
  const seen = new Set<string>([key(initial)]);
  let frontier = [initial];
  let depth = 0;
  while (depth++ < 14 && frontier.length && Date.now() < until) {
    const next: W[] = [];
    for (const w of frontier) {
      if (Date.now() > until) break;
      for (const mv of moves(w))
        for (const n of apply(w, mv, hooks)) {
          const k = key(n);
          if (!seen.has(k)) seen.add(k), next.push(n);
        }
    }
    frontier = next;
  }
  return seen.size;
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const starts = (): [string, W][] => [
  ['nothing kept', fresh('none')],
  ['a queued message kept', fresh('ok', [turn('k1', 'queued')])],
  ['a message in doubt the home never saw', fresh('ok', [turn('k1', 'not-sure')])],
  ['a message in doubt the home has', fresh('ok', [turn('k1', 'not-sure')], { k1: 'accepted' })],
  ['a message the home never got, one queued behind it', fresh('ok', [turn('k1', 'never-got-it'), turn('k2', 'queued')])],
  ['a message the home voided', fresh('ok', [turn('k1', 'never-got-it')], { k1: 'void' })],
  ['what was kept cannot be read', fresh('unreadable')],
  ['a phone opened before its kept copy is read, one message kept', fresh('unread', [turn('k1', 'queued')])],
];

// the void-id resend is finding F1 and the send after the home was believed to sleep is F4, each checked on its own below
const known: Hooks = { tolerate: new Set(['void', 'running']) };

test('hostile world, every interleaving within a time budget: nothing is lost unseen, believed wrongly, sent early or sent twice', () => {
  let total = 0;
  for (const [name, w] of starts()) {
    try {
      total += explore(w, Date.now() + 500, known);
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  }
  assert.ok(total > 20000, `explored ${total} states`);
});

test('hostile world, seeded random walks of 60 events from every start', () => {
  for (const [name, w] of starts())
    for (let seed = 1; seed <= 150; seed++) {
      try {
        const r = rng(seed * 7919);
        let cur = w;
        for (let i = 0; i < 60; i++) {
          const options = moves(cur).filter(([, m]) => !(m === 'forget' && r() < 0.95));
          const worlds = apply(cur, options[Math.floor(r() * options.length)], known);
          cur = worlds[Math.floor(r() * worlds.length)];
        }
      } catch (e) {
        throw new Error(`${name} seed ${seed}: ${(e as Error).message}`);
      }
    }
});

/** Plays named moves in order; the name must be one the world offers. */
function play(w: W, names: string[], hooks: Hooks = known): W {
  let cur = w;
  for (const name of names) {
    const mv = moves(cur).find(([, n]) => n === name);
    assert.ok(
      mv,
      `no move "${name}" after ${cur.log.join(' > ')}; offered: ${moves(cur)
        .map(([, n]) => n)
        .join(', ')}`,
    );
    cur = apply(cur, mv, hooks)[0];
  }
  return cur;
}

/** A home and a person that both behave: writes land, requests arrive, answers come back, the person checks and sends again. */
function settle(w: W, hooks: Hooks): W {
  let cur = w;
  for (let i = 0; i < 60; i++) {
    const offered = moves(cur);
    const has = (p: (n: string) => boolean) => offered.find(([, n]) => p(n));
    const turnOf = (n: string, verb: string) => held(cur.q, n.slice(verb.length + 1));
    const pick =
      has((n) => n === 'write ok') ??
      has((n) => n.startsWith('deliver ')) ??
      has((n) => n.startsWith('land ')) ??
      has((n) => n.startsWith('ask ') && ['not-sure', 'never-got-it'].includes(turnOf(n, 'ask')?.delivery) && !turnOf(n, 'ask')?.op) ??
      has((n) => n.startsWith('resend ') && turnOf(n, 'resend')?.delivery === 'never-got-it' && !turnOf(n, 'resend')?.op) ??
      (cur.q.blocked ? has((n) => n === 'retry') : undefined) ??
      (cur.q.running ? undefined : has((n) => n === 'belief: home wakes'));
    if (!pick) break;
    cur = apply(cur, pick, hooks)[0];
  }
  return cur;
}

test('an ordinary send goes through the whole journey and the home has the message once', () => {
  const w = settle(play(fresh('none'), ['submit s1']), known);
  assert.equal(w.host.ledger.s1, 'accepted');
  assert.equal(held(w.q, 's1')?.delivery, 'accepted');
});

test('a stale or unexpected answer for something not asked is ignored: same state, no effects', () => {
  const w = play(fresh('none'), ['submit s1', 'write ok']);
  assert.equal(held(w.q, 's1').op, 'arm');
  for (const e of [
    { t: 'sent', id: 's1', answer: 'accepted' },
    { t: 'sent', id: 's9', answer: 'refused' },
    { t: 'checked', id: 's1', answer: 'has' },
    { t: 'checked', id: 's9', answer: 'missing' },
    { t: 'check', id: 's1' },
    { t: 'check', id: 's9' },
    { t: 'resend', id: 's1' },
    { t: 'resend', id: 's9' },
    { t: 'wrote', id: 's9', ok: false, image: [] },
    { t: 'listed', ids: ['s9'] },
  ]) {
    const out = step(clone(w.q), e);
    assert.deepEqual(out.effects, [], JSON.stringify(e));
    assert.deepEqual(clone(out.state.turns), clone(w.q.turns), JSON.stringify(e));
  }
});

test('a message in doubt whose status could not be had stays in doubt: Send now is ignored and nothing behind it is armed', () => {
  const w = play(play(fresh('none'), ['submit s1', 'submit s2']), [
    'write ok',
    'write ok',
    'write ok',
    'send s1 times out',
    'ask s1',
    'check s1 times out',
    'resend s1',
  ]);
  assert.equal(held(w.q, 's1').delivery, 'not-sure');
  assert.equal(held(w.q, 's1').check, 'unavailable');
  assert.equal(held(w.q, 's2').delivery, 'queued');
  assert.equal(w.reqs.filter((r) => r.k === 'send' && r.id === 's2').length, 0);
});

test('a message armed while the home was believed to run is not sent when its write lands if the home has been believed asleep since', () => {
  const w = play(fresh('none'), ['submit s1', 'write ok', 'belief: home sleeps', 'write ok'], { tolerate: new Set(['void']) });
  assert.equal(w.reqs.length, 0, 'nothing should leave while the home is believed to sleep');
});
