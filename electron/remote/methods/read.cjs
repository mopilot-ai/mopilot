// The remote methods that read: the machine, the sidebar's chats, projects and scheduled tasks, and the menus a new chat or a chat offers.
const { stateOf } = require('../chatState.cjs');
const { cleanComputerName } = require('../../../shared/remote/computerName.mjs');
const { hostIdOf } = require('../phoneMachines.cjs');
const { ledgerOf } = require('../sendIdentity.cjs');
// the app's one MoMo gate (a main-process singleton, as for momoAllowed): whether the server said the account may not see MoMo, and which account it is
const { momoRevokedFor, momoUserId } = require('../../momo/access.cjs');

/** How long a list waits for the lines each chat's folder changed: Git answers a later list (the numbers are kept), never this one late. */
const STATS_WAIT_MS = 150;

/** The numbers if they come within `ms`, else none, whatever the reader does (it may never answer); the list is not held for them. @param {() => Promise<Map<string, any>> | undefined} read @param {number} ms */
async function statsWithin(read, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(new Map()), ms);
  });
  try {
    return (await Promise.race([new Promise((resolve) => resolve(read())).catch(() => new Map()), late])) ?? new Map();
  } finally {
    clearTimeout(timer);
  }
}

/** The account this Mac's word on MoMo is about (allowed, or said not to be); none when it says nothing of MoMo. */
const speaksFor = (/** @type {any} */ svc) => (svc.momoAllowed() || momoRevokedFor() ? (momoUserId() ?? momoRevokedFor()) : null);

/** The window's permission ceiling a phone may set, as the Mac's policy has it. */
const ceilingOf = (/** @type {any} */ svc) => svc.policy.permissionCeiling?.() ?? 'auto-review';

module.exports = {
  'machine.hello': async (svc, client) => ({
    v: 1,
    app: svc.version,
    // null when the name is unusable; an older Mac sends none and the phone says "Computer"
    name: cleanComputerName(svc.machineName()),
    capabilities: {
      methods: svc.methodsFor(client),
      // MoMo's two fields are absent (not false) for an account it is not allowed for, so such a phone learns nothing of it
      ...(svc.momoAllowed() ? { momo: true } : {}),
      // …and `momo: false` only when the server said, in this run, that this account may not see it (a revoke); a Mac that is offline, signed out or still loading says nothing. `momoAccount` is whose answer it is: a phone of another account reads neither
      ...(!svc.momoAllowed() && momoRevokedFor() ? { momo: false } : {}),
      ...(speaksFor(svc) ? { momoAccount: speaksFor(svc) } : {}),
      // MoMo's home (momo.home.view / momo.home.intent / the momo.home.changed event): absent unless MoMo is allowed and the `momo.home` flag is on
      ...(svc.homeOffered() ? { momoHome: true } : {}),
      pushSettings: !!svc.pushSettings,
      // the Mac lets a phone change MoMo's brain (Settings › MoMo › Brain); false for an account MoMo isn't allowed for
      ...(svc.momoAllowed() ? { momoBrainSet: svc.momo()?.brain?.allowedToSet?.() === true } : {}),
      mirrors: svc.mirror.available(client),
      permissionCeiling: ceilingOf(svc),
      // chat.send takes a sendId and answers a repeat of it once; a phone queues messages for later only with a Mac that does
      sendId: true,
      messageIdentity: 1,
      // Dedicated to MoMo's inner id + expectedChatId contract; sendId alone never certifies MoMo replay.
      ...(svc.momoAllowed() && (await ledgerOf(svc).ready()) && svc.momoAllowed() ? { momoSendDedup: 1 } : {}),
      // chats.recent takes an offset and answers `more`; a phone pages the list only with a Mac that does
      chatsPaging: true,
      // chats.recent names the chat that started each linked chat (`parentId`) and how its last turn ended (`ended`)
      linkedChats: true,
      // the user's remote machines (machines.list, machines.changed, chat.move, a chat's `hostId`); false for an account without Host
      machines: svc.hostAllowed?.() === true,
      // a phone follows, sends to, stops and starts a machine's chat itself (host.phoneChat, X4); it needs its own enrollment too
      phoneChat:
        svc.hostAllowed?.() === true && svc.host()?.phoneDirect?.enabled?.() === true && svc.host()?.phoneChat?.enabled?.() === true,
      // chat.move back to this Mac names a saved project by `projectId` (no path); a Mac without it takes only a `folder`
      moveToProject: svc.hostAllowed?.() === true,
      // chats.rename and chats.archive (the sidebar's Rename, Archive and Restore); a Mac without them leaves the phone's items off
      renameChats: typeof svc.ops?.renameChat === 'function',
      archiveChats: typeof svc.ops?.archiveChat === 'function',
      // chat.sideChat (the Mac's Side chat, a temporary fork); a Mac without it leaves the phone's menu item off, saying why
      sideChats: typeof svc.ops?.sideChat === 'function',
      // a page of older rows after the first costs this Mac a slice, not a read of the transcript (panelRowsCache.cjs): a phone fills a chat's older rows in the background only with a Mac that does (#5379)
      olderRowsHeld: true,
    },
  }),
  'chats.recent': async (svc, _client, p) => {
    // one extra row tells whether another page follows without a second query
    const rows = await svc.ops.recent(p.limit + 1, p.archived, p.offset);
    const chats = rows.slice(0, p.limit);
    // additive: the lines each chat's folder has changed since its last commit (an old Mac sends none; a chat Git could not answer for within the deadline has none)
    const stats = await statsWithin(() => svc.ops.review?.statsFor?.(chats.map((c) => c.id)), STATS_WAIT_MS);
    const host = svc.hostAllowed();
    return {
      chats: chats.map((c) => ({
        ...c,
        state: stateOf(svc.ops.turn(c.id)),
        // additive, for an account with Host only: the machine it runs on, null for this Mac (none said is this Mac too)
        ...(host && { hostId: hostIdOf(svc, c.id) }),
        ...(stats.has(c.id) && { changes: stats.get(c.id) }),
      })),
      more: rows.length > p.limit,
      // additive: this Mac's clock, so a phone whose clock differs can read each chat's `at` against its own
      now: Date.now(),
    };
  },
  'chats.pin': (svc, _client, p) => {
    if (!svc.ops.pin(p.chatId, p.pinned)) throw new Error("That chat isn't in MoPilot.");
    return { pinned: p.pinned };
  },
  'projects.list': (svc) => ({ projects: svc.ops.projects() }),
  'scheduled.list': async (svc) => {
    const tasks = await svc.ops.scheduled();
    if (!svc.hostAllowed()) return { tasks: tasks.map(({ hostId: _h, firesWhileMacAway: _f, ...t }) => t) };
    // additive, for an account with Host only: the machine a task runs on, and whether that machine fires it itself while this Mac is away
    return {
      tasks: tasks.map((t) => ({
        ...t,
        hostId: typeof t.hostId === 'string' ? t.hostId : null,
        firesWhileMacAway: t.firesWhileMacAway === true,
      })),
    };
  },
  'usage.get': (svc, _client, p) => svc.ops.usage(p),
  'accounts.get': (svc) => svc.ops.accounts(),
  'harnesses.list': async (svc, _client, p) => ({
    harnesses: await svc.ops.harnesses(),
    // additive, on request: every harness with its state and whether a chat can move to it (an older Mac sends none)
    ...(p.states && svc.ops.harnessStates && { states: await svc.ops.harnessStates() }),
  }),
  'options.get': (svc, _client, p) => svc.ops.options(p),
  'commands.list': async (svc, client, p) => {
    svc.assertPaired(client);
    const found = await svc.ops.commands(p);
    svc.assertPaired(client);
    return found;
  },
  'dictation.engine': async (svc) => ({ engine: await svc.ops.dictation.engine() }),
  'panel.browserSettings': (svc, _client, p) => svc.ops.browserSettings(p),
};
