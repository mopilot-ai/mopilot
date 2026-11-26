// DEV ONLY: the `momo-home` bench scenario: this dev host serves MoMo's home to the phone from the scripted fake (shared/momoHomeFake.mjs), over the same `momo.home.view` / `momo.home.intent` / `momo.home.changed` the Mac serves, so the phone's home screens can be driven in a simulator without a Host. Kept in a file of its own because host.mjs sits at its size limit.
import { createFakeHome, SCENARIOS } from '../../shared/momoHomeFake.mjs';
import { FIXTURE_DRAFT_ROW, FIXTURE_ROWS } from '../../shared/momoRowsFixture.ts';
import { createSafetyBench, SAFETY } from './momoSafetyBench.mjs';
import { fixtureShared } from '../../mobile/src/momoPhone/fixtures.ts';

const ANSWERS = ['lost', 'unreachable', 'switched', 'gave-up'];

/**
 * The fake home and what the service reads of it (`momoHome` option of RemoteService): off until a scenario turns it on, as for an account that was never invited.
 * @param {{ stepMs?: number }} [o]
 */
export function createMomoHomeBench({ stepMs = 400 } = {}) {
  const fake = createFakeHome({ scenario: 'running', stepMs });
  let on = false;
  let rows = false;
  const safety = createSafetyBench({ firstRun: () => fake.scenario('first-run') });
  /** What the lanes that are not registered would have changed, so the cards and the note form can be pressed: notes written, cards answered. */
  const notes = /** @type {any[]} */ ([]);
  const answered = new Map();
  const approvalNow = /** @type {Record<string, string>} */ ({
    'approval.send': 'approved',
    'approval.edit': 'approved',
    'approval.deny': 'denied',
    'approval.askAgain': 'pending',
  });
  /** What the notice pipeline's notice and a draft cut to its size look like, for the cards the fixture has none of: "Not needed" and "Cut short.". */
  const extraRows = () => [
    {
      kind: 'assistant',
      id: 'notice:dana:1',
      at: FIXTURE_DRAFT_ROW.at + 1,
      text: 'Dana Lee just replied on the Acme renewal.',
      source: 'Gmail',
      whyTold: 'Client replies',
      notNeeded: { suggestion: null },
      decision: {
        id: 'notice:dana:1',
        decisionId: 'dec-dana-1',
        outcome: 'tell_now',
        reason: 'A client replied on a live deal.',
        kind: 'Client replies',
        rule: null,
        checks: ['Sender matches Acme'],
        matter: null,
      },
    },
    { ...FIXTURE_DRAFT_ROW, id: 'draft:acme-renewal:cut', at: FIXTURE_DRAFT_ROW.at + 2, truncated: true },
    // a brief with one offer: Hide and Start, two short buttons that sit side by side
    {
      kind: 'brief',
      id: 'brief:offer:1',
      at: FIXTURE_DRAFT_ROW.at + 4,
      brief: {
        day: '2026-11-24',
        greeting: 'Good morning',
        attention: null,
        offers: [{ id: 'offer-acme', title: 'Keep an eye on the Acme renewal', why: 'Dana replied twice this week.' }],
        overnight: { read: 3, notesUpdated: 0, rulesLearned: 0 },
        leftOut: [],
      },
    },
    // the morning brief with the mail a rule kept quiet: one line the rule can be undone from, one it cannot
    {
      kind: 'brief',
      id: 'brief:quiet:1',
      at: FIXTURE_DRAFT_ROW.at + 3,
      brief: {
        day: '2026-11-24',
        greeting: 'Good morning',
        attention: null,
        offers: [],
        overnight: { read: 12, notesUpdated: 1, rulesLearned: 0 },
        leftOut: [],
        keptQuiet: [
          { id: 'q1', title: 'Newsletter from Acme', ruleId: 'rule-newsletters', label: 'Kept quiet by your rule for newsletters' },
          { id: 'q2', title: 'Receipt from Stripe', ruleId: null, label: 'Kept quiet by your rule for receipts' },
        ],
      },
    },
  ];
  /**
   * Tasks and notes for the Tasks and Notes tabs, from the phone's own fixture (the design's Acme example): a working task with Stop, a task that failed because an agent is
   * missing (its install and sign-in actions), and the notes with their lines (Forget, Edit). What is stopped or forgotten here stays so until the scenario is set again.
   */
  const shared = () => fixtureShared();
  /** @type {Set<string>} */
  const stopped = new Set();
  /** @type {Set<string>} */
  const forgotten = new Set();
  /** @type {Map<string, string>} */
  const edited = new Map();
  const tasksNow = () => [
    ...shared().tasks.map((t) => (stopped.has(t.id) ? { ...t, state: 'stopped' } : t)),
    {
      ...shared().tasks[0],
      id: 't-missing',
      title: 'Summarize the Acme thread',
      state: 'failed',
      failure: {
        code: 'agent-missing',
        message: 'Codex is not installed',
        machine: { machineId: 'mini', name: 'Mac mini' },
        agent: 'Codex',
        fix: null,
      },
    },
    {
      ...shared().tasks[0],
      id: 't-signed-out',
      title: 'Draft the renewal reply',
      state: 'failed',
      failure: {
        code: 'agent-signed-out',
        message: 'Claude Code is signed out',
        machine: { machineId: 'mini', name: 'Mac mini' },
        agent: 'Claude Code',
        fix: null,
      },
    },
  ];
  const notesNow = () =>
    shared().notes.map((n) => ({
      ...n,
      lines: n.lines.filter((l) => !forgotten.has(l.id)).map((l) => (edited.has(l.id) ? { ...l, text: edited.get(l.id) } : l)),
    }));
  /** The fixture's cards (an approval in each state, a question in each, results, a watch) after the chat the fake wrote, while `rows` is on; the notes written here. @param {any} payload */
  const withRows = (payload) => {
    if (!payload?.view) return payload;
    const shown = rows
      ? /** @type {any[]} */ ([...FIXTURE_ROWS, FIXTURE_DRAFT_ROW, ...extraRows()]).map((r) => {
          const mine = answered.get(r.kind === 'approval' ? r.approval.id : r.kind === 'question' ? r.question.id : r.id);
          return mine ? { ...r, ...mine(r) } : r;
        })
      : [];
    return {
      ...payload,
      view: {
        ...payload.view,
        chat: [...payload.view.chat, ...shown],
        notes: [...(rows ? notesNow() : []), ...payload.view.notes, ...notes],
        tasks: [...(rows ? tasksNow() : []), ...payload.view.tasks],
        problems: [...payload.view.problems, ...safety.problems()],
      },
    };
  };
  /** @param {any} raw */
  const standIn = (raw) => {
    const at = Date.now();
    // the `moving` scenario holds its seal step so the card can be looked at: a cancel lets it go, or the move would never end
    if (raw?.kind === 'move-cancel') fake.release();
    if (raw?.kind === 'note.write' && typeof raw.title === 'string') {
      const id = `note-${notes.length + 1}`;
      notes.push({
        id,
        title: raw.title,
        kind: 'topic',
        updatedAt: at,
        lastChange: null,
        lines: [{ id: `${id}-1`, text: String(raw.text), at, status: 'confirmed', quote: null, sources: [] }],
        history: [],
      });
      return true;
    }
    // "Not needed": the row stops offering it (the notice lane's own handler answers on a real home)
    if (raw?.kind === 'row.notNeeded') {
      answered.set(raw.rowId, () => ({ notNeeded: null }));
      return true;
    }
    // Undo rule on a kept-quiet line: the rule goes, so the line offers it no more
    if (raw?.kind === 'rule.undo') {
      answered.set('brief:quiet:1', (/** @type {any} */ r) => ({
        brief: {
          ...r.brief,
          keptQuiet: r.brief.keptQuiet.map((/** @type {any} */ k) => (k.ruleId === raw.id ? { ...k, ruleId: null } : k)),
        },
      }));
      return true;
    }
    // the Tasks and Notes tabs' own buttons (their lanes answer on a real home)
    if (raw?.kind === 'task.stop') {
      stopped.add(raw.id);
      return true;
    }
    if (raw?.kind === 'note.forget') {
      forgotten.add(raw.lineId);
      return true;
    }
    if (raw?.kind === 'note.edit') {
      edited.set(raw.lineId, String(raw.text));
      return true;
    }
    // Hide or Start on the brief's offer: the offer is answered
    if (raw?.kind === 'brief.hide' || raw?.kind === 'brief.start') {
      answered.set('brief:offer:1', (/** @type {any} */ r) => ({ brief: { ...r.brief, offers: [] } }));
      return true;
    }
    if (raw?.kind === 'question.answer') {
      answered.set(raw.id, (/** @type {any} */ r) => ({
        question: { ...r.question, status: 'answered', answer: { optionId: raw.optionId, device: 'iPhone', at } },
      }));
      return true;
    }
    if (typeof raw?.kind === 'string' && raw.kind in approvalNow) {
      const status = approvalNow[raw.kind];
      answered.set(raw.id, (/** @type {any} */ r) => ({
        approval: { ...r.approval, status, body: raw.body ?? r.approval.body, canAskAgain: status === 'denied' },
      }));
      return true;
    }
    return false;
  };
  const api = {
    view: async () => withRows(await fake.api.view()),
    intent: async (/** @type {any} */ raw) => {
      const fixed = await safety.fix(raw);
      if (fixed) return fixed.ok ? { ok: true, ...withRows(await fake.api.view()) } : fixed;
      return standIn(raw) ? { ok: true, ...withRows(await fake.api.view()) } : withRows(await fake.api.intent(raw));
    },
  };
  return {
    fake,
    /** @param {boolean} next */
    showRows(next) {
      rows = next;
    },
    /** One of the home-safety states (older, replaced, blocked, home-lost, unheard), or none. @param {string | null} next */
    showSafety(next) {
      safety.show(next);
    },
    /** @param {boolean} next */
    turn(next) {
      on = next;
    },
    /** What `new RemoteService({ momoHome })` takes. */
    momoHome: {
      api: () => api,
      flagOn: () => on,
      on: (/** @type {(payload: object) => void} */ fn) => fake.api.onChanged((p) => fn(withRows(p))),
    },
  };
}

/**
 * `momo-home [scenario|off] [answer]`: serve MoMo's home to the phone in that scenario (running, the default) and allow MoMo for the account; `off` takes it away.
 * `answer` scripts what the other machine says of a stuck move (lost, unreachable, switched, gave-up).
 * @param {ReturnType<typeof createMomoHomeBench>} home
 * @param {{ momo: boolean }} bench
 * @param {() => void} changed tells the phones their hello changed
 */
export function momoHomeScenario(home, bench, changed) {
  return {
    usage: `momo-home [${SCENARIOS.join('|')}|off] [${ANSWERS.join('|')}|rows|${SAFETY.join('|')}]`,
    about:
      'this host serves MoMo’s home to the phone from the scripted fake, in a scenario (running is the default) and allows MoMo for the account; off takes it away. A second word scripts what the other machine answers about a stuck move (lost, unreachable, switched, gave-up), or `rows` adds the shared fixture cards to the chat: an approval in every state, a question in every state, results and a watch',
    run: (/** @type {string[]} */ [name = 'running', answer]) => {
      home.showRows(answer === 'rows');
      home.showSafety(SAFETY.includes(/** @type {any} */ (answer)) ? /** @type {string} */ (answer) : null);
      if (name === 'off') {
        home.turn(false);
        changed();
        return 'MoMo’s home is no longer served: the phone shows no MoMo home';
      }
      if (!SCENARIOS.includes(/** @type {any} */ (name)))
        throw new Error(`Usage: momo-home [${SCENARIOS.join('|')}|off] [${ANSWERS.join('|')}]`);
      if (answer !== undefined && answer !== 'rows' && !ANSWERS.includes(answer) && !SAFETY.includes(answer))
        throw new Error(`The word after the scenario is rows, one of ${ANSWERS.join(', ')} or one of ${SAFETY.join(', ')}.`);
      bench.momo = true;
      home.turn(true);
      home.fake.scenario(/** @type {any} */ (name));
      if (answer && answer !== 'rows' && !SAFETY.includes(answer)) home.fake.targetAnswer(/** @type {any} */ (answer));
      changed();
      return `MoMo’s home is served in "${name}"${answer ? ` (${answer === 'rows' ? 'with the fixture cards' : SAFETY.includes(answer) ? `with the home-safety state ${answer}` : `the other machine says: ${answer}`})` : ''}: reopen MoMo on the phone to read it`;
    },
  };
}

/**
 * The scenarios with `momo-home` among them.
 * @template {{ list: () => { usage: string, about: string }[], run: (name: string, args?: string[]) => unknown }} S
 * @param {S} scenarios
 * @param {ReturnType<typeof createMomoHomeBench>} home
 * @param {{ momo: boolean }} bench
 * @param {() => void} changed
 */
export function withMomoHome(scenarios, home, bench, changed) {
  const mine = momoHomeScenario(home, bench, changed);
  return {
    ...scenarios,
    list: () => [...scenarios.list(), { usage: mine.usage, about: mine.about }],
    run: (/** @type {string} */ name, /** @type {string[]} */ args = []) =>
      name === 'momo-home' ? mine.run(args) : scenarios.run(name, args),
  };
}
