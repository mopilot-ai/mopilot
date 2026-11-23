// How a Host settles a chat's move to another agent (D13, #4278): the app's own SwitchRunner (electron/session/switch.cjs) built from this Host's parts, and what the protocol asks of a runtime that can switch: whether it can, which agent a chat runs on now, holding or dropping the person's choice, and the choice as clients see it on the state lane.
import { createRequire } from 'node:module';
import { UnsupportedError } from './errors.mjs';
import { runGit } from './hostGit.mjs';

const require = createRequire(import.meta.url);
const { SwitchRunner } = require('../../electron/session/switch.cjs');
const { permissionParams } = require('../../electron/harness/codex.cjs');
const { createGitQueries } = require('../../electron/platform/gitQueries.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');

const HARNESS = /^(codex|claude|acp:[\w.-]{1,64})$/;
const MODES = new Set(['auto', 'summary', 'transcript', 'workspace']);
const text = (/** @type {unknown} */ v, max = 200) => typeof v === 'string' && v.length <= max;

/** Git as the handoff record reads it: this Host's own hardened git; a failed command is exit code 1 (a detached HEAD). @param {string} _cmd @param {string[]} args @param {{ cwd: string }} o */
const gitRun = async (_cmd, args, { cwd }) => {
  const r = await runGit(args, { cwd, timeout: 10_000 });
  return { ok: r.ok, stdout: r.stdout, code: r.ok ? 0 : 1 };
};

/**
 * The runner, built from this Host's parts.
 * @param {object} o
 * @param {any} o.chats the Host's ChatsStore
 * @param {() => any} o.controller the chat controller (late-bound: it takes the runner)
 * @param {{ claudeTurns: any, claude: any }} o.claude the family's adapter and harness (the same objects the app's wiring hands the runner)
 * @param {any} o.codex the Codex adapter
 * @param {any} o.acpHost
 * @param {string} o.home the folder a chat without one runs in
 * @param {() => string | undefined} [o.claudeBin] the Claude Code CLI this Host runs
 * @param {(event: object) => void} o.emit the Host's stream
 * @param {(chatId: string, harness: string) => void} o.settled told when a switch settled: the choice is spent, and what follows the chat's agent moves
 * @param {(chatId: string, note: { from: string, to: string, text: string, at: number }) => void} o.told told when a switch settled, with the divider the chat shows there: the Host journals it as an item every client mirrors
 * @param {(line: string) => void} o.log
 */
export function createHostSwitcher({
  chats,
  controller,
  claude,
  codex,
  acpHost,
  home,
  claudeBin = () => undefined,
  emit,
  settled,
  told,
  log,
}) {
  const { gitInfo, gitStatus } = createGitQueries({ run: gitRun });
  const runner = new SwitchRunner({
    chats,
    ref: (/** @type {string} */ chatId) => controller().ref(chatId),
    invalidate: () => controller().invalidate(),
    claim: (/** @type {string} */ key, /** @type {string} */ chatId) => controller().claim(key, chatId),
    unclaim: (/** @type {string} */ key, /** @type {string} */ chatId) => controller().unclaim(key, chatId),
    // the switch settled: clients learn the chat's agent from its state lane, not from window broadcasts
    changed: (/** @type {string} */ chatId) => {
      const harness = controller().ref(chatId).kind;
      settled(chatId, harness);
      emit({ kind: 'state', chatId, patch: { harness, pendingSwitch: null } });
    },
    prefs: () => ({ permission: 'default', serviceTier: undefined, claudeBin: claudeBin() }),
    home,
    // a toast or a 'switched' notice is the app window's; a Host's person hears of a failed switch from the send's own refusal
    emit: (/** @type {{ kind: string, level?: string, text?: string }} */ event) => {
      if (event.kind === 'toast' && event.level === 'error') log(`switch: ${event.text}`);
    },
    git: { info: gitInfo, status: gitStatus },
    codex: {
      startThread: (/** @type {object} */ params, /** @type {object} */ opts) => codex.startThread(params, opts),
      ensureResumed: (/** @type {string} */ id) => codex.ensureResumed(id),
      threadTurns: (/** @type {string} */ id, /** @type {unknown} */ page) => codex.threadTurns(id, page),
      summarize: (/** @type {string} */ id, /** @type {string} */ prompt) => codex.summarize(id, prompt),
      cwdOf: (/** @type {string} */ id) => codex.cwdOf(id),
    },
    claude: {
      registerSession: (/** @type {string} */ key, /** @type {object} */ info) => claude.claudeTurns.registerSession(key, info),
      isFresh: (/** @type {string} */ key) => claude.claudeTurns.isFresh(key),
      cwdOf: (/** @type {object} */ ref) => claude.claudeTurns.cwdOf(ref),
      accountOf: (/** @type {string} */ chatId) => claude.claudeTurns.accountOf(chatId),
      allTurns: (/** @type {string} */ sessionId, /** @type {object} */ opts) => claude.claude.allTurns(sessionId, opts),
      summarize: (
        /** @type {string} */ sessionId,
        /** @type {string} */ cwd,
        /** @type {string} */ prompt,
        /** @type {string} */ bin,
        /** @type {unknown} */ account,
        /** @type {string} */ chatId,
      ) => claude.claude.summarize(sessionId, cwd, prompt, bin, account, chatId),
    },
    permissionParams,
    acpHost,
  });
  const perform = runner.perform.bind(runner);
  // a settled switch is told with the divider the chat shows (a chat continued from another Host is not a switch of agent)
  runner.perform = async (/** @type {string} */ chatId, /** @type {any} */ ps, /** @type {unknown} */ origin) => {
    const from = controller().ref(chatId).kind;
    const done = await perform(chatId, ps, origin);
    if (done?.ready && done.note?.text && !ps.continue)
      told(chatId, { from, to: ps.harness, text: String(done.note.text).slice(0, 300), at: Date.now() });
    return done;
  };
  return runner;
}

/**
 * A held choice read back from disk, or null when it is not one: only the fields the runner reads, each checked, so a damaged or foreign file can never make a switch the person did not choose.
 * @param {any} raw
 * @returns {{ harness: string, model: string | null, modelLabel: string, mode: string, effort?: string, credential?: { source: string, login?: string } } | null}
 */
export function readHold(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.harness !== 'string' || !HARNESS.test(raw.harness)) return null;
  if (!(raw.model === null || text(raw.model)) || !text(raw.modelLabel) || !MODES.has(raw.mode)) return null;
  const c = raw.credential;
  if (
    c !== undefined &&
    !(c && typeof c === 'object' && ['own', 'key', 'org'].includes(c.source) && (c.login === undefined || text(c.login, 64)))
  )
    return null;
  if (raw.effort !== undefined && !text(raw.effort)) return null;
  return {
    harness: raw.harness,
    model: raw.model,
    modelLabel: raw.modelLabel,
    mode: raw.mode,
    ...(raw.effort === undefined ? {} : { effort: raw.effort }),
    ...(c === undefined ? {} : { credential: { source: c.source, ...(c.login === undefined ? {} : { login: c.login }) } }),
  };
}

/** The family a message lands on: the agent a held choice moves the chat to, else the one it runs on. @param {{ harness: string } | null | undefined} pending @param {string} family */
export const landsOn = (pending, family) => (pending ? (parseKind(pending.harness)?.family ?? family) : family);

/** The choice as the state lane tells it: the agent and model, never the credential. @param {{ harness: string, model?: string | null } | null | undefined} pending */
export const laneChoice = (pending) => (pending ? { harness: pending.harness, ...(pending.model ? { model: pending.model } : {}) } : null);

/**
 * What the protocol asks of a runtime that can switch (host/src/methods/chatSwitch.mjs, host/src/stream.mjs).
 * @param {object} o
 * @param {any} o.chats
 * @param {any} o.state the SessionStore
 * @param {() => any} o.controller
 * @param {{ acp: boolean, claude: boolean, codex: boolean }} o.provided the families this Host runs
 * @param {Record<string, string>} o.labels how the person knows a family
 * @param {(chatId: string, pending: object | null) => void} o.hold keeps the choice on disk until it settles or is dropped (null)
 */
export function switchRuntime({ chats, state, controller, provided, labels, hold }) {
  return {
    switching: true,
    /** The agent the chat runs on now and the one a held choice moves it to (null: none), or null when this Host has no such chat. @param {string} chatId */
    switchState(chatId) {
      if (!chats.records.has(chatId) && !state.has(chatId)) return null;
      return {
        harness: controller().ref(chatId).kind,
        pending: state.has(chatId) ? (state.get(chatId).pendingSwitch?.harness ?? null) : null,
      };
    },
    /**
     * The person's choice, held on the chat until its next message settles it (null: dropped). An agent whose family this Host does not run is refused here, with the family's name.
     * @param {string} chatId @param {{ harness: string } | null} pending
     */
    choose(chatId, pending) {
      const family = pending ? (parseKind(pending.harness)?.family ?? null) : 'any';
      if (!family || (family !== 'any' && !provided[/** @type {'acp' | 'claude' | 'codex'} */ (family)]))
        throw new UnsupportedError(`${labels[/** @type {string} */ (family)] ?? 'That agent'} is not available on this Host.`);
      hold(chatId, pending);
      state.patch(chatId, { pendingSwitch: pending });
    },
    /** The choice this Host holds now, for a lane a restart left a stale one on. @param {string} chatId */
    liveChoice: (chatId) => ({ pendingSwitch: laneChoice(state.has(chatId) ? state.get(chatId).pendingSwitch : null) }),
  };
}

/**
 * The model and effort a message runs with: its own, unless a held switch is about to move the chat to another agent. The message that settles it was sent with the old agent's picks (the app freezes them with the message), which the new agent may not offer: the held choice's, the new agent's own, go instead.
 * @param {{ model?: string | null, effort?: string | null } | null | undefined} held @param {{ model?: string, effort?: string } | undefined} pick
 */
export function settlingPick(held, pick) {
  if (!held) return pick;
  return { ...(held.model ? { model: held.model } : {}), ...(held.effort ? { effort: held.effort } : {}) };
}
