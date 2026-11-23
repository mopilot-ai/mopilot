// The ChatController fixture shared by the controller edge-case tests: three harness kinds over fake turn starters.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../../../electron/session/state.cjs');
const { ChatController } = require('../../../electron/session/controller.cjs');

/** Chats by id: 'cx…' Codex, 'cl…' Claude, 'acp…' ACP (kimi), 'bad…' a kind this build doesn't know. */
export function setup(o: any = {}) {
  const kindOf = (id: string) =>
    id.startsWith('cl') ? 'claude' : id.startsWith('acp') ? 'acp:kimi' : id.startsWith('bad') ? 'nope' : 'codex';
  const rec = (id: string) => ({ id, segments: [{ kind: kindOf(id), nativeId: id }] });
  const records = new Map((o.ids ?? ['cx1']).map((id: string) => [id, rec(id)]));
  const chats = { record: rec, records };
  const state = new SessionStore();
  const log: any[] = [];
  const step = (what: string) => async (chatId: string, _ref: any, item: any, origin: any) => (
    log.push([what, chatId, item?.text, origin]), o.result ?? { started: true }
  );
  const c = new ChatController({
    state,
    chats,
    codex: {
      startTurn: step('turn'),
      startGoal: step('goal'),
      steer: step('steer'),
      stopTurn: async (id: string) => (log.push(['stopTurn', id]), true),
    },
    claudeTurns: {
      startTurn: step('claude-turn'),
      steer: step('claude-steer'),
      stop: async (id: string) => void log.push(['claude-stop', id]),
      crashed: () => {},
    },
    acpTurns: { startTurn: step('acp-turn') },
    switcher: o.switcher,
    claude: { send: async (...a: any[]) => (log.push(['claude-send', a[0], a[2]]), true) },
    acp: { send: async (...a: any[]) => (log.push(['acp-send', a[0]]), true), cancel: (k: string) => (log.push(['acp-cancel', k]), true) },
    ...o.ctl,
  });
  return { c, state, log, s: (id: string) => state.get(id) };
}
