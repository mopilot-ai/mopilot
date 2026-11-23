// Shared Claude renderer harness mocks, native callbacks, state and timer fixture.
// Claude Code harness, renderer side (src/session/harness/claude.ts): chats, turns, the events main relays,
// following sessions other apps run, commands, edit and fork.
import { after, beforeEach } from 'node:test';
import { called, fx, reset, storeSet, tick } from '../harness-logic-fakes.ts';
import { defined } from '../defined.ts';
import { turnsOver } from '../claude-turns-fake.ts';

const intervals: (() => void)[] = [];
const realInterval = globalThis.setInterval;
globalThis.setInterval = ((fn: () => void) => (intervals.push(fn), { unref() {} })) as any;
after(() => void (globalThis.setInterval = realInterval));
const claude = await import('../../../src/session/harness/claude.ts');
const { claudeThreadId } = await import('../../../src/harness/types.ts');
const { noteOwner } = await import('../../../src/harness/ownership.ts');

const flush = async () => {
  for (let i = 0; i < 12; i++) await tick();
};
const log: any[] = [];
const rec =
  (name: string, ret: any = undefined) =>
  (...args: any[]) => (log.push([name, ...args]), typeof ret === 'function' ? ret(...args) : ret);
const notes = (method?: string) => called('applyNotification').filter((n) => !method || n[0] === method);

let onEvent: (e: any) => void;
let onItems: (e: any) => void;
let onAccountsEvent: (e: any) => void;
let onCatalog: (e: any) => void;
function baseNative(o: any = {}) {
  fx.native.claude = {
    onEvent: (h: any) => (onEvent = h),
    onItems: (h: any) => (onItems = h),
    onAccountsEvent: (h: any) => (onAccountsEvent = h),
    onCatalog: (h: any) => (onCatalog = h),
    accounts: async () => ({ active: 'default', accounts: [] }),
    detect: async () => ({ state: 'signin', bin: null }),
    // a test's transcript is its messages, read through main's turn paging
    messages: async () => [],
    turns: turnsOver((sid) => fx.native.claude.messages(sid)),
    watch: rec('watch', async () => true),
    unwatch: rec('unwatch', async () => true),
    sessionSettings: async () => null,
    checkpoints: async () => null,
    presence: async () => ({}),
    ...o,
  };
  fx.native.session = {
    snapshot: async () => ({ turn: 'idle', runningElsewhere: true }),
    claudeOwn: rec('claudeOwn', async () => true),
    claudeNew: rec('claudeNew', async () => true),
    send: rec('send', async () => ({ action: 'steered', id: 'claude-steer' })),
    claudeStop: rec('claudeStop', async () => true),
    claudeGoal: rec('claudeGoal', async () => true),
  };
}

beforeEach(() => {
  reset();
  log.length = 0;
  baseNative();
});

const userMsg = (uuid: string, text: string, ago = 0) => ({
  type: 'user',
  uuid,
  timestamp: new Date(Date.now() - ago).toISOString(),
  message: { role: 'user', content: text },
});
const reply = (text: string) => ({ type: 'assistant', uuid: `r-${text}`, message: { content: [{ type: 'text', text }] } });
const result = () => ({ type: 'result', subtype: 'success', is_error: false, usage: {} });
const UUID = '12345678-1234-1234-1234-123456789abc';

const evStarting = (chat: string, clientId: string, o: any = {}) => ({
  kind: 'turnStarting',
  chatId: chat,
  key: chat,
  clientId,
  turnId: `ct-${clientId}`,
  text: 'go',
  attachments: [],
  model: 'opus',
  opts: {},
  account: 'default',
  ...o,
});
const evStarted = (chat: string, o: any = {}) => ({
  kind: 'turnStarted',
  chatId: chat,
  key: chat,
  text: 'go on then',
  elsewhere: [],
  want: { model: 'opus', effort: null, permission: 'default', fast: false, account: 'default' },
  ...o,
});

export {
  called,
  fx,
  storeSet,
  tick,
  defined,
  intervals,
  claude,
  claudeThreadId,
  noteOwner,
  flush,
  log,
  rec,
  notes,
  onEvent,
  onItems,
  onAccountsEvent,
  onCatalog,
  baseNative,
  userMsg,
  reply,
  result,
  UUID,
  evStarting,
  evStarted,
};
