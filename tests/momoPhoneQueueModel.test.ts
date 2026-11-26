// The held-message queue as a model: every interleaving of taps, writes, answers, kills and forgets up to a depth is explored, and after every step a message the person sent is never lost without being told, and never sent twice without the home's status answer in between.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const queuePath = '../mobile/src/momoPhone/queue';
const { start, step, restore, imageOf } = await import(queuePath);

type Any = any;
type Ghost = {
  /** ids whose save was acknowledged and that are not resolved since */
  kept: string[];
  /** sends since the home last gave a status for this id */
  sends: Record<string, number>;
  submitted: number;
};
type World = { q: Any; pending: Any[]; ghost: Ghost; log: string[] };

const turn = (id: string, delivery: string) => ({ id, text: `m${id}`, at: 1, delivery });

function apply(w: World, e: Any, name: string): World | null {
  const label = `${[...w.log, name].join(' > ')}`;
  const out = step(w.q, e);
  const ghost: Ghost = { kept: [...w.ghost.kept], sends: { ...w.ghost.sends }, submitted: w.ghost.submitted };
  const pending = [...w.pending];
  // the effect this event answers is no longer on its way
  const answered = pending.findIndex((f: Any) =>
    e.t === 'wrote'
      ? f.t === 'write'
      : e.t === 'sent'
        ? f.t === 'send' && f.id === e.id
        : e.t === 'checked'
          ? f.t === 'check' && f.id === e.id
          : false,
  );
  if (answered >= 0) pending.splice(answered, 1);
  const q = out.state;
  const before = new Set<string>(w.q.turns.filter((t: Any) => t.delivery !== 'accepted').map((t: Any) => t.id));
  const after = new Set<string>(q.turns.map((t: Any) => t.id));
  const rejected = new Set<string>(out.effects.filter((f: Any) => f.t === 'reject').map((f: Any) => f.id));
  const told = out.effects.some((f: Any) => f.t === 'tell');
  for (const id of before) {
    if (after.has(id)) continue;
    const explained = e.t === 'forget' || (e.t === 'listed' && e.ids.includes(id)) || rejected.has(id);
    assert.ok(explained, `${label}: ${id} vanished with no reason`);
    if (rejected.has(id)) assert.ok(told, `${label}: ${id} was rejected and the person was not told`);
  }
  for (const f of out.effects) {
    if (f.t === 'send') {
      assert.equal(w.q.disk, 'ok', `${label}: sent with nothing durable`);
      const held = q.image.find((t: Any) => t.id === f.id);
      assert.equal(held?.delivery, 'not-sure', `${label}: ${f.id} left before the doubt was on the phone`);
      assert.equal(ghost.sends[f.id] ?? 0, 0, `${label}: ${f.id} sent twice with no status answer between`);
      ghost.sends[f.id] = 1;
    }
    if (f.t !== 'reject' && f.t !== 'tell') pending.push(f);
  }
  // the home's answers that are a status
  if ((e.t === 'sent' && e.answer === 'refused') || (e.t === 'checked' && e.answer === 'missing') || e.t === 'adopt') ghost.sends[e.id] = 0;
  if (e.t === 'wrote' && e.ok && e.id) {
    const was = w.q.turns.find((t: Any) => t.id === e.id);
    if (was?.op === 'save' && !ghost.kept.includes(e.id)) ghost.kept.push(e.id);
  }
  // resolved: the home has it (accepted) or let go on purpose
  ghost.kept = ghost.kept.filter((id) => {
    const t = q.turns.find((x: Any) => x.id === id);
    return !!t && t.delivery !== 'accepted';
  });
  for (const id of ghost.kept) {
    const durable = q.image.some((t: Any) => t.id === id);
    assert.ok(durable, `${label}: ${id} was kept, is still held, and is not on the phone`);
  }
  return { q, pending, ghost, log: [...w.log, name] };
}

const key = (w: World) => JSON.stringify([w.q, w.pending, w.ghost]);

function moves(w: World): [Any, string][] {
  const out: [Any, string][] = [];
  const { q } = w;
  for (const id of ['s1', 's2'])
    if (w.ghost.submitted < 2 && !w.log.includes(`submit ${id}`)) out.push([{ t: 'submit', id, text: `m${id}`, at: 1 }, `submit ${id}`]);
  const head = w.pending.find((f: Any) => f.t === 'write');
  if (head) {
    out.push([{ t: 'wrote', id: head.id, ok: true, image: head.image }, 'write ok']);
    out.push([{ t: 'wrote', id: head.id, ok: false, image: head.image }, 'write fails']);
  }
  for (const f of w.pending.filter((p: Any) => p.t === 'send'))
    for (const answer of ['accepted', 'refused', 'unanswered']) out.push([{ t: 'sent', id: f.id, answer }, `send ${f.id} ${answer}`]);
  for (const f of w.pending.filter((p: Any) => p.t === 'check'))
    for (const answer of ['has', 'missing', 'unavailable']) out.push([{ t: 'checked', id: f.id, answer }, `check ${f.id} ${answer}`]);
  for (const t of q.turns) {
    out.push([{ t: 'check', id: t.id }, `ask ${t.id}`]);
    out.push([{ t: 'resend', id: t.id }, `resend ${t.id}`]);
    out.push([{ t: 'listed', ids: [t.id] }, `listed ${t.id}`]);
  }
  out.push([{ t: 'retry' }, 'retry']);
  out.push([{ t: 'home', running: !q.running }, q.running ? 'home sleeps' : 'home wakes']);
  out.push([{ t: 'forget' }, 'forget']);
  if (q.disk === 'unreadable') out.push([{ t: 'discard' }, 'discard']);
  return out;
}

/** A kill: any prefix of the writes still on their way may have landed; the phone then opens again from what is there. */
function kills(w: World): World[] {
  const writes = w.pending.filter((f: Any) => f.t === 'write');
  const worlds: World[] = [];
  for (let landed = 0; landed <= writes.length; landed++) {
    const image = landed ? writes[landed - 1].image : w.q.image;
    const q = restore({ ...w.q, image });
    // what the phone held when it was killed is what the person sees again; held messages are not forgotten by it
    worlds.push({
      q: { ...q, disk: 'ok' },
      pending: [],
      ghost: { ...w.ghost, kept: w.ghost.kept.filter((id) => image.some((t: Any) => t.id === id)) },
      log: [...w.log, `kill after ${landed} writes`],
    });
  }
  return worlds;
}

function explore(initial: World, depth: number) {
  const seen = new Set<string>();
  let frontier = [initial];
  let count = 0;
  for (let d = 0; d < depth; d++) {
    const next: World[] = [];
    for (const w of frontier) {
      const candidates: World[] = [];
      for (const [e, label] of moves(w)) {
        const n = apply(w, e, label);
        if (n) candidates.push({ ...n, ghost: { ...n.ghost, submitted: n.log.filter((l) => l.startsWith('submit')).length } });
      }
      // a kill discards every submit that was not on the phone: the person's draft is theirs again
      candidates.push(...kills(w));
      for (const n of candidates) {
        const k = key(n);
        if (seen.has(k)) continue;
        seen.add(k);
        count++;
        next.push(n);
      }
    }
    frontier = next;
  }
  return count;
}

const world = (read: 'none' | 'ok' | 'unreadable', turns: Any[] = []): World => {
  const q = step(step(start(), { t: 'home', running: true }).state, { t: 'load', read, turns }).state;
  return {
    q,
    pending: [],
    ghost: {
      kept: turns.map((t) => t.id),
      sends: Object.fromEntries(turns.filter((t) => t.delivery === 'not-sure').map((t) => [t.id, 1])),
      submitted: 0,
    },
    log: [],
  };
};

test('nothing a person sent is lost without being told, and nothing is sent twice without a status answer: every interleaving to depth 7', () => {
  const starts: [string, World][] = [
    ['nothing kept', world('none')],
    ['a queued message kept', world('ok', [turn('k1', 'queued')])],
    ['a message kept in doubt', world('ok', [turn('k1', 'not-sure')])],
    ['a message the home never got', world('ok', [turn('k1', 'never-got-it'), turn('k2', 'queued')])],
    ['what was kept cannot be read', world('unreadable')],
  ];
  let total = 0;
  for (const [name, w] of starts) {
    try {
      total += explore(w, 7);
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  }
  assert.ok(total > 2000, `explored ${total} states`);
});

test('every write holds what is saved or being saved, and not a message still waiting its turn', () => {
  const q = {
    ...start('ok'),
    turns: [{ ...turn('a', 'queued') }, { ...turn('b', 'queued'), op: 'save' }, { ...turn('c', 'queued'), op: 'hold' }],
  };
  assert.deepEqual(
    imageOf(q.turns).map((t: Any) => t.id),
    ['a', 'b'],
  );
});

test('a doubt that was written while the home went to sleep is not sent: the message waits again', () => {
  let q = step(step(start(), { t: 'home', running: true }).state, { t: 'load', read: 'none' }).state;
  let out = step(q, { t: 'submit', id: 'a', text: 'hi', at: 1 });
  out = step(out.state, { t: 'wrote', id: 'a', ok: true, image: [] });
  assert.equal(out.state.turns[0].op, 'arm');
  out = step(out.state, { t: 'home', running: false });
  out = step(out.state, { t: 'wrote', id: 'a', ok: true, image: [] });
  assert.deepEqual(
    [out.effects.some((f: Any) => f.t === 'send'), out.state.turns[0].delivery, out.state.turns[0].op],
    [false, 'queued', undefined],
  );
});
