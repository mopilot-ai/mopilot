// Every intent a client may send to MoMo's home (`momo.home.intent { intent }`), as one table, and the seam a lane registers its handlers through (home lane, #5474). An intent is `{ kind, ...args }`; a kind that is not in this table is not something MoMo can do, and a kind in it without a handler answers "MoMo can't do that yet" until its lane registers one (the test that lists what is still pending shrinks as lanes land).
import { IntentError } from './momoHomeApi.mjs';

/** The lanes that own handlers. `home` is the home lane (moves, machines, the chat's turns). */
export const LANES = /** @type {const} */ (['home', 'gate', 'tasks', 'notice', 'google']);

/**
 * Argument types: `string`, `object`, `boolean`, `number`, each optional with a trailing `?`. `lease: true` marks an intent that acts on the home's data: it is refused
 * unless the home is running here and now (the registry checks, not the handler).
 * @type {Record<string, { lane: (typeof LANES)[number], args: Record<string, string>, lease: boolean }>}
 */
export const INTENT_TABLE = {
  // where MoMo lives and its machines
  'choose-home': { lane: 'home', args: { machineId: 'string' }, lease: false },
  move: { lane: 'home', args: { toId: 'string' }, lease: false },
  'move-cancel': { lane: 'home', args: {}, lease: false },
  'move-retry': { lane: 'home', args: {}, lease: false },
  'move-stay': { lane: 'home', args: {}, lease: false },
  'move-ack': { lane: 'home', args: {}, lease: false },
  reclaim: { lane: 'home', args: { moveId: 'string?', toId: 'string?' }, lease: false },
  wake: { lane: 'home', args: {}, lease: false },
  'update-machine': { lane: 'home', args: { machineId: 'string' }, lease: false },
  'install-agent': { lane: 'home', args: { machineId: 'string', agent: 'string' }, lease: false },
  'sign-in-agent': { lane: 'home', args: { machineId: 'string', agent: 'string' }, lease: false },
  'set-up-machine': { lane: 'home', args: { machineId: 'string' }, lease: false },
  fix: { lane: 'home', args: { id: 'string' }, lease: false },
  // the chat's turns
  // a message sent while MoMo sleeps is held and delivered when it wakes, so sending needs no running home
  send: { lane: 'home', args: { turnId: 'string', text: 'string' }, lease: false },
  'check-turn': { lane: 'home', args: { turnId: 'string' }, lease: false },
  'stop-turn': { lane: 'home', args: { turnId: 'string?' }, lease: true },
  // approval cards, notes, rules (the gate lane)
  'approval.send': { lane: 'gate', args: { id: 'string' }, lease: true },
  'approval.edit': { lane: 'gate', args: { id: 'string', body: 'string' }, lease: true },
  'approval.deny': { lane: 'gate', args: { id: 'string' }, lease: true },
  'approval.askAgain': { lane: 'gate', args: { id: 'string' }, lease: true },
  // one answer to a question card (shared/momoView.ts `MomoQuestionView`): the first answer from any device wins
  'question.answer': { lane: 'gate', args: { id: 'string', optionId: 'string' }, lease: true },
  'note.edit': { lane: 'gate', args: { noteId: 'string', lineId: 'string', text: 'string' }, lease: true },
  'note.undo': { lane: 'gate', args: { noteId: 'string', changeId: 'string' }, lease: true },
  'note.restore': { lane: 'gate', args: { noteId: 'string' }, lease: true },
  // with `lineId` one line of the note is forgotten, without it the whole note
  'note.forget': { lane: 'gate', args: { noteId: 'string', lineId: 'string?' }, lease: true },
  'note.write': { lane: 'gate', args: { title: 'string', text: 'string' }, lease: true },
  'rule.add': { lane: 'gate', args: { text: 'string', effect: 'string' }, lease: true },
  'rule.edit': { lane: 'gate', args: { id: 'string', text: 'string', effect: 'string', inBrief: 'boolean?' }, lease: true },
  'rule.undo': { lane: 'gate', args: { id: 'string' }, lease: true },
  // turn a rule that was switched off back on
  'rule.turnOn': { lane: 'gate', args: { id: 'string' }, lease: true },
  'rule.turnOff': { lane: 'gate', args: { id: 'string' }, lease: true },
  'rule.accept': { lane: 'gate', args: { id: 'string' }, lease: true },
  // tasks and the offers MoMo makes (the tasks lane)
  // a button on a task's result card or on the task: `fixId` is the id of one of the card's actions (`MomoResultView.actions`), `id` the task
  'task.act': { lane: 'tasks', args: { id: 'string', fixId: 'string' }, lease: true },
  // Check now on a watching task, and Snooze it for a length of time (ms; the home adds it to its own clock)
  'task.check': { lane: 'tasks', args: { id: 'string' }, lease: true },
  'task.snooze': { lane: 'tasks', args: { id: 'string', forMs: 'number' }, lease: true },
  'task.stop': { lane: 'tasks', args: { id: 'string' }, lease: true },
  'task.retry': { lane: 'tasks', args: { id: 'string' }, lease: true },
  'task.runElsewhere': { lane: 'tasks', args: { id: 'string', machineId: 'string' }, lease: true },
  'task.stopWatching': { lane: 'tasks', args: { id: 'string' }, lease: true },
  'brief.start': { lane: 'tasks', args: { offerId: 'string' }, lease: true },
  // the notice pipeline and its settings (the notice lane)
  // the notification's own buttons (Draft a reply, Remind me later): `key` is the matter or card key the notification named (`host.momoIntent`)
  'notice.draft': { lane: 'notice', args: { key: 'string' }, lease: true },
  'notice.remind': { lane: 'notice', args: { key: 'string' }, lease: true },
  'brief.hide': { lane: 'notice', args: { offerId: 'string' }, lease: true },
  'row.notNeeded': { lane: 'notice', args: { rowId: 'string', decisionId: 'string?' }, lease: true },
  'signal.make': { lane: 'notice', args: { id: 'string' }, lease: true },
  'signal.ignore': { lane: 'notice', args: { id: 'string' }, lease: true },
  'settings.set': { lane: 'notice', args: { patch: 'object' }, lease: true },
  // the Google connection (the Google lane): `intent` is connect, reconnect, grant-send or remove; `client` names the device kind
  google: { lane: 'google', args: { intent: 'string', client: 'string' }, lease: false },
  'source.reconnect': { lane: 'google', args: { id: 'string' }, lease: false },
  'source.remove': { lane: 'google', args: { id: 'string' }, lease: false },
};

/** The lanes whose handlers run on the DEVICE the person is using (the Mac, the phone), not on a Host: they need that device (a browser for a sign-in), and reach the Host through its wire methods. The composition of the home API registers them. */
export const DEVICE_LANES = /** @type {readonly (typeof LANES)[number][]} */ (['google']);
/** The lanes whose handlers run on the home's Host, next to their services (`home.service(lane).intents`); the home lane's kinds and the device lanes' are the client's own. */
export const HOST_LANES = LANES.filter((l) => l !== 'home' && !DEVICE_LANES.includes(l));

const TYPES = new Set(['string', 'object', 'boolean', 'number']);
/** @param {unknown} v @param {string} spec */
const fits = (v, spec) => {
  const optional = spec.endsWith('?');
  const type = optional ? spec.slice(0, -1) : spec;
  if (v === undefined || v === null) return optional;
  if (type === 'object') return typeof v === 'object' && !Array.isArray(v);
  return typeof v === type;
};
/** @param {string} kind @param {any} intent @returns {boolean} whether the intent carries the table's arguments, each of its type */
export const argsFit = (kind, intent) => {
  const entry = Object.hasOwn(INTENT_TABLE, kind) ? INTENT_TABLE[kind] : null;
  return !!entry && Object.entries(entry.args).every(([name, spec]) => TYPES.has(spec.replace('?', '')) && fits(intent?.[name], spec));
};

/**
 * Where handlers are registered. Two registries share this code. On a Host, `host/src/momoWiring.mjs` registers each lane service's `intents` map (the handlers run next
 * to the data, under the Host's own lease) and `host.momoLaneIntent` runs one for a paired owner device. On the Mac, the composition of the home API registers the home
 * lane's own handlers (machines, moves, the chat's turns) and `forwardedIntents(call)` for every other lane, which sends the intent to the home's Host.
 * The registry checks what no handler should have to: the kind is in the table and is this lane's, it is registered once, the
 * arguments are the table's (else the intent is not something MoMo can do), and an intent that acts on the home's data runs only while the home runs here.
 * @param {object} o
 * @param {() => boolean} [o.running] whether this Host or Mac is the running home now (a `lease: true` intent is refused otherwise)
 */
export function createIntentRegistry({ running = () => true } = {}) {
  /** @type {Map<string, (intent: any) => unknown>} */
  const handlers = new Map();
  return {
    /** @param {(typeof LANES)[number]} lane @param {Record<string, (intent: any) => unknown>} mine */
    register(lane, mine) {
      // all or nothing: a map with one kind the table refuses registers none of its kinds
      for (const kind of Object.keys(mine)) {
        const entry = Object.hasOwn(INTENT_TABLE, kind) ? INTENT_TABLE[kind] : null;
        if (!entry) throw new Error(`Intent "${kind}" is not in the table (shared/momoIntents.mjs).`);
        if (entry.lane !== lane) throw new Error(`Intent "${kind}" belongs to the ${entry.lane} lane, not ${lane}.`);
        if (handlers.has(kind)) throw new Error(`Intent "${kind}" already has a handler.`);
      }
      for (const [kind, run] of Object.entries(mine)) {
        const entry = INTENT_TABLE[kind];
        handlers.set(kind, (/** @type {any} */ intent) => {
          if (!argsFit(kind, intent)) throw new IntentError('That is not something MoMo can do.');
          if (entry.lease && !running()) throw new IntentError('MoMo isn’t running on this machine right now.');
          return run(intent);
        });
      }
    },
    /** The handlers as `createHomeApi` takes them. */
    intents: () => Object.fromEntries(handlers),
    /** Kinds in the table with no handler yet, sorted. */
    pending: () =>
      Object.keys(INTENT_TABLE)
        .filter((k) => !handlers.has(k))
        .sort(),
    registered: () => [...handlers.keys()].sort(),
  };
}

/**
 * The handlers the Mac registers for every kind a Host lane owns: each sends the intent to the home's Host (`host.momoLaneIntent`) and answers as the Host did, a
 * refusal carrying the Host's own words (and fix) as an `IntentError`.
 * @param {(method: string, params: object) => Promise<any>} call a call to the home's Host
 * @returns {Record<string, Record<string, (intent: any) => Promise<unknown>>>} the handlers by lane, for `registry.register(lane, handlers)`
 */
export function forwardedIntents(call) {
  /** @param {any} intent */
  const send = async (intent) => {
    const answer = await call('host.momoLaneIntent', { intent });
    if (answer?.ok === true) return answer.value;
    throw new IntentError(typeof answer?.cause === 'string' ? answer.cause : 'MoMo can’t do that yet.', {
      fix: answer?.fix,
      fixLabel: answer?.fixLabel,
    });
  };
  return Object.fromEntries(
    HOST_LANES.map((lane) => [
      lane,
      Object.fromEntries(
        Object.entries(INTENT_TABLE)
          .filter(([, e]) => e.lane === lane)
          .map(([kind]) => [kind, send]),
      ),
    ]),
  );
}
