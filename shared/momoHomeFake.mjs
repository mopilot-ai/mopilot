// A scripted MoMo home for the clients' own checks (the device check by ios-audit, the Mac's E2E spec): answers `momo.home.view`, `momo.home.intent` and `momo.home.changed` with scripted views of every state the design draws, over the same code the real home uses (the home view, the move runner, `moveHome` over fake sides), so a screen that works against this works against the real answers. No Host, no disk, no network, no model.
import { createHomeApi, IntentError } from './momoHomeApi.mjs';
import { homeView, deliveryOf, turnAnswer } from './momoHomeView.mjs';
import { createMoveRunner } from './momoMoveRunner.mjs';
import { createIntentRegistry } from './momoIntents.mjs';

/** Every state a screen can be shown, by name. */
export const SCENARIOS = Object.freeze([
  'first-run',
  'running',
  'asleep',
  'needs-update',
  'needs-sign-in',
  'moving',
  'move-failed',
  'move-old-offline',
  'move-stuck',
  'moved-away',
  'lost-connection',
]);

/** The names a screen shows for the agent ids an intent carries. @type {Record<string, string>} */
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' };
const agent = (/** @type {string} */ name, signedIn = true, id = name.split(' ')[0].toLowerCase()) => ({
  id,
  name,
  installed: true,
  signedIn,
});

/**
 * @param {object} [o]
 * @param {(typeof SCENARIOS)[number]} [o.scenario]
 * @param {number} [o.stepMs] how long each step of a scripted move takes
 * @param {() => number} [o.now]
 */
export function createFakeHome({ scenario = 'running', stepMs = 400, now = Date.now } = {}) {
  /** @type {any} */
  let S;
  /** The `moving` scenario holds its move at "Sealed" until `release()`, so the progress sheet can be looked at. */
  let held = false;
  /** @type {(() => void)[]} */
  const waiting = [];
  let ids = 0;
  /** @type {ReturnType<typeof createHomeApi>} */
  let api;
  let runner = /** @type {ReturnType<typeof createMoveRunner>} */ (/** @type {unknown} */ (null));
  let applied = null;

  /** A fake Host's two calls: every step answers, after a pause, and the scripted failure is thrown where the scenario puts it. @param {string} name */
  const side = (name) => ({
    call: async (/** @type {string} */ op, /** @type {any} */ p = {}) => {
      await new Promise((r) => setTimeout(r, stepMs));
      if (held && op === 'seal') await new Promise((r) => waiting.push(() => r(undefined)));
      if (S.failOp === op) throw Object.assign(new Error(S.failWhy), { code: 'failed' });
      if (op === 'begin') return { home: { leaseEpoch: 1 } };
      if (op === 'offer') return { targetKey: 'scripted', signKey: 'scripted', fingerprint: '4F2A-91C0' };
      if (op === 'seal') return { sealed: 'scripted', bundleHash: 'h'.repeat(64) };
      if (op === 'commit') return { receipt: 'scripted-receipt' };
      if (op === 'discard') {
        const said = S.targetAnswer ?? 'gave-up';
        if (said === 'unreachable') throw new Error('connect ECONNREFUSED');
        if (said === 'switched') return { committed: true, leaseEpoch: 2, receipt: 'scripted-receipt', homeId: S.target };
        return { discarded: true, proof: said === 'lost' ? null : 'scripted-proof' };
      }
      if (op === 'cancel' && !p.proof && S.targetAnswer === 'lost')
        throw Object.assign(new Error('The other machine hasn’t said it gave the move up.'), { code: 'move_not_given_up' });
      if (op === 'reclaim') return { home: { leaseEpoch: 3, state: 'running' } };
      return { ok: true, name };
    },
  });

  /** @param {string} id */
  const machine = (id) => {
    const m = S.machines.find((/** @type {any} */ x) => x.id === id);
    return m ? { id: m.id, name: m.name, side: side(m.name) } : null;
  };

  const fresh = () => {
    const base = {
      homeId: /** @type {string | null} */ ('studio'),
      movedTo: /** @type {{ name: string, at: number } | null} */ (null),
      asleep: false,
      failOp: /** @type {string | null} */ (null),
      failWhy: '',
      target: /** @type {string | null} */ (null),
      rows: /** @type {any[]} */ ([]),
      machines: [
        {
          id: 'studio',
          name: 'Studio',
          isThisDevice: false,
          reachable: true,
          current: true,
          stays: 'on',
          setUp: true,
          agents: [agent('Claude Code'), agent('Codex')],
        },
        {
          id: 'mac',
          name: 'This Mac',
          isThisDevice: true,
          reachable: true,
          current: true,
          stays: 'sleeps',
          setUp: true,
          agents: [agent('Claude Code')],
        },
        {
          id: 'mini',
          name: 'Mac mini',
          isThisDevice: false,
          reachable: true,
          current: true,
          stays: 'on',
          setUp: true,
          agents: [agent('Claude Code')],
        },
        {
          id: 'cloud',
          name: 'Cloud machine',
          isThisDevice: false,
          reachable: false,
          current: true,
          stays: 'cloud',
          setUp: false,
          agents: [],
        },
      ],
    };
    const by = {
      'first-run': () => ({ ...base, homeId: null }),
      running: () => base,
      asleep: () => ({ ...base, asleep: true }),
      'needs-update': () => ({
        ...base,
        machines: base.machines.map((m) => (m.id === 'studio' ? { ...m, current: false, hostBuild: '0.9.1', needBuild: '1.0.0' } : m)),
      }),
      'needs-sign-in': () => ({
        ...base,
        machines: base.machines.map((m) =>
          m.id === 'studio' ? { ...m, agents: [agent('Claude Code', false), agent('Codex', false)] } : m,
        ),
      }),
      moving: () => base,
      'move-failed': () => ({ ...base, failOp: 'receive', failWhy: 'Mac mini stopped answering.' }),
      // the switch's answer was lost and the old home is paused: Reclaim is offered (the target answers `targetAnswer`: lost, unreachable, switched or gave-up)
      'move-stuck': () => ({ ...base, failOp: 'commit', failWhy: 'Mac mini stopped answering.', targetAnswer: 'lost' }),
      'move-old-offline': () => ({ ...base, failOp: 'finish', failWhy: 'Studio is offline.' }),
      'moved-away': () => ({ ...base, homeId: null, movedTo: { name: 'Studio', homeId: 'studio', at: now() - 3_600_000 } }),
      'lost-connection': () => ({
        ...base,
        rows: [
          { kind: 'user', id: 'key-lost0001', at: now() - 60_000, text: 'Yes, attach it and show me the reply.', delivery: 'not-sure' },
        ],
      }),
    };
    return /** @type {any} */ (by[/** @type {keyof typeof by} */ (scenario)] ?? by.running)();
  };

  const update = (/** @type {(m: any) => any} */ f, /** @type {string} */ id) => {
    S.machines = S.machines.map((/** @type {any} */ m) => (m.id === id ? f(m) : m));
  };

  const compose = async () => {
    const mv = runner.view();
    const moving = !!mv && !mv.failure && mv.step !== 'cleaning-up';
    const home = S.homeId ? S.machines.find((/** @type {any} */ m) => m.id === S.homeId) : null;
    const t = now();
    const status = {
      home: S.homeId
        ? {
            homeId: S.homeId,
            state: moving ? 'moving' : 'running',
            stateSince: t - 3_600_000,
            lastSeenAt: t - (S.asleep ? 600_000 : 1000),
            name: home.name,
          }
        : S.movedTo
          ? { homeId: null, state: 'none', stateSince: 0, lastSeenAt: 0, name: '', movedTo: S.movedTo }
          : null,
    };
    const machines = S.machines.map((/** @type {any} */ m) => (m.id === S.homeId && S.asleep ? { ...m, reachable: false } : m));
    const view = homeView({ status: /** @type {any} */ (status), heardAt: S.asleep ? t - 600_000 : t - 1000, now: t, machines, move: mv });
    const rows = S.asleep && S.homeId ? [...S.rows, { kind: 'waiting', id: 'wait-1', at: t, machineName: home.name }] : S.rows;
    return { home: view, rest: { chat: rows } };
  };

  /** The scripted move finished: the target is the home from then on. */
  const settle = () => {
    const r = runner.result();
    if (r && r.ok && applied !== r) {
      applied = r;
      S.homeId = runner.target();
      S.failOp = null;
    }
  };

  const reset = () => {
    S = fresh();
    applied = null;
    held = false;
    waiting.length = 0;
    S.target = 'mini';
    runner = createMoveRunner({
      home: () => (S.homeId ? { id: S.homeId, name: S.machines.find((/** @type {any} */ m) => m.id === S.homeId).name } : null),
      machine,
      newId: () => `move-fake${String(++ids).padStart(4, '0')}`,
      changed: () => {
        settle();
        void api.changed();
      },
    });
  };

  const intents = () => ({
    'choose-home': ({ machineId }) => {
      if (!machine(machineId)) throw new IntentError('That machine is not available.');
      S.homeId = machineId;
      S.movedTo = null;
    },
    wake: () => {
      if (!S.asleep) throw new IntentError('Nothing is asleep.');
      S.asleep = false;
      // everything the chat holds while MoMo sleeps was sent while it slept (the waiting row is composed, not kept), so all of it is delivered now
      S.rows = S.rows.map((/** @type {any} */ r) => ({ ...r, delivery: 'accepted' }));
    },
    move: ({ toId }) => runner.start(toId),
    'move-cancel': () => runner.cancel(),
    'move-retry': () => {
      S.failOp = null;
      return runner.retry();
    },
    'move-stay': () => runner.stay(),
    // the owner's Reclaim: the runner asks the target first, so a screen only sends this intent (params `moveId` and `toId` only when this device did not run the move)
    reclaim: async (i) => {
      const r = await runner.reclaim({ moveId: i.moveId, toId: i.toId });
      S.failOp = null;
      return r;
    },
    'move-ack': () => runner.acknowledge(),
    'update-machine': ({ machineId }) => update((m) => ({ ...m, current: true, hostBuild: m.needBuild }), machineId),
    'set-up-machine': ({ machineId }) => update((m) => ({ ...m, current: true, hostBuild: m.needBuild }), machineId),
    'install-agent': ({ machineId, agent: a }) =>
      update((m) => ({ ...m, agents: [...m.agents, agent(AGENT_NAMES[a] ?? String(a), true, String(a))] }), machineId),
    'sign-in-agent': ({ machineId }) =>
      update((m) => ({ ...m, agents: m.agents.map((/** @type {any} */ a) => ({ ...a, signedIn: true })) }), machineId),
    send: ({ turnId, text }) => {
      const delivery = deliveryOf({ outbox: S.asleep ? 'not-sent' : 'sent-uncertain', ledger: S.asleep ? null : 'accepted' });
      // the same id again is the same turn: one row, never two (the home accepts one copy and answers the other as a duplicate)
      if (S.rows.some((/** @type {any} */ r) => r.id === turnId)) {
        S.rows = S.rows.map((/** @type {any} */ r) => (r.id === turnId ? { ...r, delivery } : r));
        return;
      }
      S.rows = [...S.rows, { kind: 'user', id: turnId, at: now(), text, delivery }];
    },
    // the turn in flight is stopped: its row is told it was cancelled (a named turn, or the newest still going)
    'stop-turn': ({ turnId }) => {
      const going = S.rows.findLast((/** @type {any} */ r) => r.kind === 'user' && (turnId ? r.id === turnId : r.delivery === 'accepted'));
      if (!going) throw new IntentError('There is no turn to stop.');
      S.rows = S.rows.map((/** @type {any} */ r) => (r === going ? { ...r, delivery: 'cancelled' } : r));
    },
    // a fix the view offered that no handler of this home knows
    fix: () => {
      throw new IntentError('That fix is not offered here any more.');
    },
    'check-turn': ({ turnId }) => {
      const said =
        turnAnswers.get(turnId) ??
        turnAnswer({
          ledger: S.rows.some((/** @type {any} */ r) => r.id === turnId && r.delivery !== 'never-got-it') ? 'accepted' : 'unknown',
          homeRunning: !S.asleep && !!S.homeId,
        });
      // what the screen shows follows what the home said
      const delivery = { has: 'accepted', missing: 'never-got-it', unknown: 'not-sure' }[said];
      S.rows = S.rows.map((/** @type {any} */ r) => (r.id === turnId ? { ...r, delivery } : r));
      return { turn: said };
    },
  });

  /** What the home answers when asked about a turn (`check-turn`), by turn id: a journey scripts `has`, `missing` or `unknown`. @type {Map<string, 'has' | 'missing' | 'unknown'>} */
  const turnAnswers = new Map();
  /** The next intent of a kind that is refused, with its cause and the fix a screen offers: a journey's way to make an intent fail. @type {Map<string, { cause: string, fix?: object, fixLabel?: string }>} */
  const refusals = new Map();
  const scripted = Object.fromEntries(
    Object.entries(intents()).map(([kind, run]) => [
      kind,
      (/** @type {any} */ intent) => {
        const no = refusals.get(kind);
        if (no) {
          refusals.delete(kind);
          throw new IntentError(no.cause, { fix: no.fix, fixLabel: no.fixLabel });
        }
        return /** @type {(i: any) => unknown} */ (run)(intent);
      },
    ]),
  );
  // made once: a screen that subscribed keeps its subscription when the scenario changes under it
  // every handler goes through the one table and its checks (shared/momoIntents.mjs); the other lanes' kinds stay pending until their lanes register
  const registry = createIntentRegistry({ running: () => !S.asleep && !!S.homeId });
  registry.register('home', scripted);
  api = createHomeApi({ compose, intents: registry.intents() });
  const begin = () => {
    // a move held at "Sealed", so the progress sheet can be looked at
    if (scenario !== 'moving') return;
    held = true;
    void runner.start('mini');
  };
  reset();
  begin();
  return {
    /** What the one table says is still without a handler (the other lanes' kinds). */
    pending: () => registry.pending(),
    /** The three methods and the event, as the real home serves them. */
    get api() {
      return api;
    },
    /** The next intent of `kind` returns ok:false with this cause (and a fix a screen can offer); the one after that runs as it does. @param {string} kind @param {string} cause @param {object} [fix] @param {string} [fixLabel] */
    refuse(kind, cause, fix, fixLabel) {
      refusals.set(kind, { cause, fix, fixLabel });
    },
    /** Script what the target answers when asked how a stuck move stands. @param {'lost' | 'unreachable' | 'switched' | 'gave-up'} answer */
    targetAnswer(answer) {
      S.targetAnswer = answer;
    },
    /** Script what the home answers when asked about a turn: `has`, `missing` or `unknown`. @param {string} turnId @param {'has' | 'missing' | 'unknown'} answer */
    turnAnswer(turnId, answer) {
      turnAnswers.set(turnId, answer);
    },
    /** Let a held move go on. */
    release: () => {
      held = false;
      for (const go of waiting.splice(0)) go();
    },
    /** Back to a scenario's start. */
    scenario: (/** @type {(typeof SCENARIOS)[number]} */ next) => {
      scenario = next;
      reset();
      begin();
      void api.changed();
    },
  };
}
