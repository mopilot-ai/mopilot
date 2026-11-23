// Shared real-controller fixture and fake clock for usage-limit lifecycle and independent preference tests.
import { beforeEach, afterEach } from 'node:test';
import { createRequire } from 'node:module';
import { setup, tick, selectSegment } from './controller/fixture.ts';
import { fakeClock } from './ports/clock.ts';

const require = createRequire(import.meta.url);
const { LimitContinuation, SETTLE_MS } = require('../../electron/session/limitContinue.cjs');
const { installClock } = require('../../electron/platform/ports/clock.cjs');

export const CHAT = 'stable-chat';
export const BASE = 1_000_000;
export const SEGMENTS: Record<string, [string, string][]> = {
  codex: [['codex', 'native-thread']],
  claude: [['claude', 'native-claude']],
  'acp:kimi': [['acp:kimi', 'native-acp']],
};

export let clock: ReturnType<typeof fakeClock>;
beforeEach(() => {
  clock = fakeClock(BASE);
  installClock(clock);
});
afterEach(() => installClock(null));

interface Opts {
  kind?: string;
  enabled?: boolean;
  switchEnabled?: boolean;
  to?: string | null;
  resetAt?: (kind: string) => number | null;
  receipt?: () => Promise<{ action: string } | undefined>;
  make?: boolean;
  prefs?: boolean;
}

/** A chat on `kind`, its limit continuation wired to the real controller's hooks, and what it asked of its services. */
export async function rig(o: Opts = {}) {
  const h = setup();
  const kind = o.kind ?? 'codex';
  selectSegment(h.c, h.chats, CHAT, SEGMENTS[kind]);
  const chosen: [string, string][] = [];
  const sent: { chatId: string; item: any; ps: any }[] = [];
  const abort = new AbortController();
  const settings = {
    enabled: o.enabled ?? true,
    switchEnabled: o.switchEnabled ?? true,
    to: o.to === undefined ? 'claude' : o.to,
    resetAt: o.resetAt ?? (() => null),
  };
  const limit = new LimitContinuation({
    controller: h.c,
    signal: abort.signal,
    resumeEnabled: () => settings.enabled,
    switchEnabled: () => settings.switchEnabled,
    exhausted: () => true,
    prefs: o.prefs === false ? undefined : () => ({ model: 'gpt-6.1-sol', claudeSelection: { model: 'opus' } }),
    choose: async (chatId: string, own: string) => (chosen.push([chatId, own]), settings.to),
    resetAt: (k: string) => settings.resetAt(k),
    send: async (chatId: string, item: any) => {
      sent.push({ chatId, item, ps: h.s(chatId).pendingSwitch });
      const receipt = await (o.receipt ? o.receipt() : { action: 'started' });
      // a start that took the message settled the switch
      if (receipt?.action === 'started') h.state.patch(chatId, { pendingSwitch: null });
      return receipt;
    },
    make: o.make
      ? (_chat: string, text: string, show: object) => ({ id: 'authored-1', text, show, attachments: [], opts: { human: false } })
      : null,
  });
  /** The chat runs a turn, hits its limit, and the turn ends. */
  const limited = async (turn = 'limit-turn') => {
    h.c.send(CHAT, { text: 'work', opts: { human: true } }, null);
    await tick();
    h.c.onLimit(CHAT);
    h.c.end(CHAT, { outcome: 'failed' });
    return turn;
  };
  const settle = async () => {
    clock.advance(SETTLE_MS);
    await tick();
  };
  return { ...h, limit, chosen, sent, abort, settings, limited, settle };
}
