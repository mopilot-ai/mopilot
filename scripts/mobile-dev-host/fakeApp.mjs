// DEV ONLY: a small honest fake of MoPilot under the Mac-side remote service. The service, the item feed and the session store are the real ones; only the chats are made up: a few seeded ones, and new ones that run a scripted turn (streamed reply, a command that waits for the phone's approval, a final reply).
import { createFakeDictation } from './fakeDictation.mjs';
import { createRequire } from 'node:module';
import { createFakeSwitch } from './fakeSwitch.mjs';
import { CHOICES, codex, fakeAccounts, optionsOf, COMMANDS, fakeUsage, GONE, HARNESSES, SCHEDULED, SEEDS } from './fakeData.mjs';
import { createModelMenu } from './fakeModels.mjs';
import { fakeChatOps } from './fakeChatOps.mjs';
import { createPictures } from './fakePictures.mjs';
import { recentRows } from './fakeRecent.mjs';
import { createSurfaces } from './fakeSurfaces.mjs';
import { openingLine } from './scriptLines.mjs';
export { GONE, HARNESSES };

const require = createRequire(import.meta.url);
const { SessionStore } = require('../../electron/session/state.cjs');
const { openPhoneItems } = require('../../electron/app/chromePanelPhones.cjs');
const { createPanelAt, createPanelStartAt } = require('../../electron/app/chromePanelAt.cjs');
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** `git status --short` in the repository, as the scripted command's real output. child_process is loaded only here, so a host that passes its own `status` (the App Review demo host) never loads it. */
const gitStatus = async (/** @type {string} */ cwd) => {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) =>
    execFile('git', ['status', '--short'], { cwd, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => resolve(String(out || '(clean)\n'))),
  );
};
/** What a script throws to end its turn: a Stop (the phone's, or the Mac's), or a failure with a message. */
class StopTurn extends Error {}
class FailTurn extends Error {}

/**
 * @param {object} o
 * @param {string} o.repo the folder every chat works in
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {(ms: number) => Promise<void>} [o.sleep] the pause between streamed words (tests pass none)
 * @param {(cwd: string) => Promise<string>} [o.status] what the scripted command prints
 * @param {typeof SEEDS} [o.seeds] the chats it starts with
 * @param {string} [o.refuseSwitch] refuse every agent switch with this message
 * @param {number} [o.latency] milliseconds the calls of a chat's controls take, standing in for the relay (default 0)
 * @param {Parameters<typeof createPanelAt>[0]['search']} [o.search] how the @ menu finds files (default: the real search, which starts a program)
 */
export function createFakeApp({
  repo,
  log = () => undefined,
  now = Date.now,
  sleep = wait,
  status = gitStatus,
  seeds = SEEDS,
  search,
  latency = 0,
  refuseSwitch = '',
}) {
  /** @type {any} */
  let service = null;
  const chats = new Map();
  const cards = new Map();
  const state = new SessionStore({ publish: (/** @type {any} */ p) => service?.onSessionPatch(p) });
  const feed = openPhoneItems({
    service: () => service,
    chatOf: (/** @type {string} */ id) => id,
    rows: async (/** @type {string} */ chatId, /** @type {number} */ n) => {
      if (readFailures.left > 0) {
        readFailures.left -= 1;
        throw new Error(readFailures.message);
      }
      return (chats.get(chatId)?.rows ?? []).slice(-n);
    },
  });
  /** The next reads of a chat fail with this message, then reads work again (the `follow-error` scenario). */
  const readFailures = { left: 0, message: '' };
  /** @type {Map<string, { model?: string, effort?: string | null, permission?: string }>} what each chat's phone menus chose; a new chat is keyed '' */
  const picked = new Map();
  const { menuOf, ...accountOps } = fakeAccounts(log);
  const moves = createFakeSwitch({ chats, log, sleep, latency, refuse: refuseSwitch });
  let counter = 0;
  const models = createModelMenu();
  /** @type {Map<string, { abort: AbortController, answer: ((key: string) => void) | null, values?: unknown }>} the running turn of each chat and what answers its card */
  const turns = new Map();
  /** attachment id to file name, for the send's log line */
  const attached = new Map();
  /** the pictures messages carry, kept so their thumbnails can be read again (messages.image) */
  const pics = createPictures();

  const live = (/** @type {any} */ event) => feed.live('codex', event);
  /** A history row; a reply the turn streamed keeps its item's `rowId`, so a phone that reads the chat does not show the same reply as a live item and as a saved row. A message with pictures says how many (`images`), as the Mac's history does. */
  const row = (
    /** @type {any} */ chat,
    /** @type {string} */ role,
    /** @type {string} */ text,
    id = `${chat.id}-r${chat.rows.length + 1}`,
    /** @type {{ images?: string[], clientId?: string }} */ { images = [], clientId } = {},
  ) => {
    chat.rows.push({ role, text, id, ...(images.length ? { images: images.length } : {}), ...(clientId ? { clientId } : {}) });
    pics.keep(chat.id, id, images);
  };
  /** Puts a card up in the chat; `extra` adds fields the phone knows (a plan's `kind` and `plan`, its own choices). */
  function raise(/** @type {any} */ chat, /** @type {{ title: string, detail?: string, choices?: object[] }} */ ask, extra = {}) {
    const id = `a${++counter}`;
    const { choices = CHOICES, ...shown } = ask;
    cards.set(chat.id, [{ id, ...shown, ...extra, choices, version: `v${counter}` }]);
    state.patch(chat.id, { turn: 'awaitingUser', approvals: [{ id, method: 'item/commandExecution/requestApproval', params: {} }] });
    log(`app: ${chat.id} asks "${ask.title}"${ask.detail ? ` (${ask.detail})` : ''} [card ${id}]`);
    return id;
  }
  const clear = (/** @type {any} */ chat, /** @type {string} */ turn) => {
    cards.delete(chat.id);
    state.patch(chat.id, { turn, approvals: [] });
  };

  /**
   * One scripted turn. The script gets the toolkit `t`: every call that shows something to the phone ends the turn by
   * throwing when it was stopped, so a script reads straight through. It ends as completed, interrupted (a Stop) or failed.
   * @param {any} chat @param {(t: any) => Promise<unknown>} script
   */
  async function runScript(chat, script) {
    // an old ask nothing is running behind (the seeded chat's card) goes away when a turn starts in its chat
    turns.get(chat.id)?.abort.abort();
    const turn = { abort: new AbortController(), answer: /** @type {((key: string) => void) | null} */ (null) };
    turns.set(chat.id, turn);
    // a Stop denies the card the turn is waiting on
    turn.abort.signal.addEventListener('abort', () => turn.answer?.('deny'));
    const n = ++counter;
    let items = 0;
    /** @type {Map<string, string>} the command items shown and not yet completed, with their commands */
    const open = new Map();
    const check = () => {
      if (turn.abort.signal.aborted) throw new StopTurn();
    };
    const t = {
      signal: turn.abort.signal,
      chat,
      /** Waits `ms` (the app's own pause, so a test that passes none does not wait). */
      pause: (/** @type {number} */ ms) => sleep(ms),
      row: (/** @type {string} */ role, /** @type {string} */ text) => row(chat, role, text),
      /** Streams a message word by word (`burst` words at a time); a Stop leaves it complete with what was sent. */
      async say(/** @type {string} */ text, { delay = 40, record = true, burst = 1 } = {}) {
        check();
        const itemId = `m${n}-${++items}`;
        live(codex.message(chat.id, 'item/started', itemId, ''));
        let sofar = '';
        let sent = 0;
        for (const word of text.split(/(?<= )/)) {
          if (turn.abort.signal.aborted) break;
          live(codex.delta(chat.id, itemId, word));
          sofar += word;
          // `burst` words go out together, then the pause: a network that delivers in clumps
          if (++sent % burst === 0) await sleep(delay);
        }
        live(codex.message(chat.id, 'item/completed', itemId, sofar));
        check();
        // the id the feed gives the item's `rowId`, which is how a phone knows a saved row and a live item are one reply
        if (record) row(chat, 'assistant', text, JSON.stringify([chat.id, 't', 'agentMessage', itemId]));
      },
      /** Shows a command as running; finish it with `finish`. */
      start(/** @type {string} */ command) {
        const id = `c${n}-${++items}`;
        open.set(id, command);
        live(codex.command(chat.id, id, command, 'inProgress', null));
        return { id, command };
      },
      finish(/** @type {{ id: string, command: string }} */ { id, command }, /** @type {string | null} */ output, state = 'completed') {
        open.delete(id);
        live(codex.command(chat.id, id, command, state, output));
      },
      /** Puts a card up and waits for the answer, from the phone, from the Mac (`macAnswers`) or a Stop (which denies). */
      async ask(
        /** @type {{ title: string, detail?: string, choices?: object[] }} */ card,
        extra = {},
        /** @type {(cardId: string) => void} */ raised = () => undefined,
      ) {
        check();
        const key = await new Promise((resolve) => {
          turn.answer = resolve;
          raised(raise(chat, card, extra));
        });
        turn.answer = null;
        clear(chat, 'running');
        check();
        return /** @type {string} */ (key);
      },
      /** The values a phone answered the last card with (a question card's answers), or undefined before one. */
      values: () => turn.values,
      /** Ends the turn as failed, with what the phone shows as the reason. */
      fail(/** @type {string} */ message) {
        throw new FailTurn(message);
      },
    };
    state.patch(chat.id, { turn: 'running' });
    live(codex.turn(chat.id, 'turn/started', 'inProgress'));
    log(`app: ${chat.id} turn started`);
    let ended = 'completed';
    let reason = '';
    try {
      await script(t);
    } catch (error) {
      if (error instanceof StopTurn) ended = 'interrupted';
      else if (error instanceof FailTurn) [ended, reason] = ['failed', error.message];
      else {
        ended = 'failed';
        throw error;
      }
    } finally {
      for (const [id, command] of open) live(codex.command(chat.id, id, command, 'declined', null));
      turns.delete(chat.id);
      clear(chat, 'idle');
      live(codex.turn(chat.id, 'turn/completed', ended, reason));
      chat.at = now();
      log(
        `app: ${chat.id} turn ${ended === 'completed' ? 'finished' : ended === 'interrupted' ? 'stopped' : `failed${reason ? ` (${reason})` : ''}`}`,
      );
    }
    return ended;
  }

  /** The turn a chat started from the phone runs: a streamed note, a command the phone approves or denies, a streamed result. */
  const defaultScript = (/** @type {string} */ first) => async (/** @type {any} */ t) => {
    await t.say(first);
    const command = t.start('git status --short');
    const key = await t.ask({ title: 'Run this command?', detail: 'git status --short' });
    if (key === 'once') {
      const out = await status(repo);
      t.finish(command, out);
      t.row('step', 'Ran git status --short');
      await t.say(`git status lists ${out.trim().split('\n').length} changed entries and nothing is staged.`);
    } else {
      t.finish(command, null, 'declined');
      await t.say('Understood, I did not run it. Tell me if you want a different check.');
    }
  };

  /** Hands the answer to whoever waits for the chat's card, once. */
  function settle(/** @type {string} */ chatId, /** @type {string} */ key) {
    const turn = turns.get(chatId);
    const answer = turn?.answer;
    if (!turn || !answer) return false;
    turn.answer = null;
    answer(key);
    return true;
  }

  /** Runs `script` after the chat's current turn ends (a Stop retires the turns still waiting); a turn that completes sends the next queued message, as the Mac does. */
  const enqueue = (/** @type {any} */ chat, /** @type {(t: any) => Promise<unknown>} */ script) => {
    const epoch = chat.epoch;
    chat.at = now();
    chat.pending = (chat.pending ?? 0) + 1;
    chat.tail = chat.tail
      .then(async () => {
        if (epoch !== chat.epoch) return;
        // a Stop keeps the queue and sends nothing; a turn that ended any other way (completed or failed) sends the first message waiting
        const ended = await runScript(chat, script).catch((e) => (drain(chat), Promise.reject(e)));
        if (ended !== 'interrupted') drain(chat);
      })
      .catch((e) => log(`app: turn failed: ${e?.message ?? e}`))
      .finally(() => void chat.pending--);
    return chat.tail;
  };
  /** A message goes: its row and the item the controller streams for it (with the pictures and the phone's native id, as the Mac's does), then its turn. */
  const say = (/** @type {any} */ chat, /** @type {string} */ text, /** @type {{ images: string[], clientId?: string }} */ sent) => {
    const item = `u${++counter}`;
    row(chat, 'user', text, undefined, sent);
    pics.keep(chat.id, item, sent.images);
    live(codex.user(chat.id, item, text, sent.images.length, sent.clientId));
    enqueue(chat, defaultScript(openingLine(text, sent.images.length)));
  };
  /** The first queued message goes: its row, then its turn (ChatController.drain). */
  const drain = (/** @type {any} */ chat) => {
    const [next, ...rest] = state.get(chat.id).queue;
    if (!next) return;
    state.patch(chat.id, { queue: rest });
    log(`app: ${chat.id} sends the queued message "${next.text}"`);
    say(chat, next.text, { images: pics.held(chat.id, next.id), clientId: next.nativeId });
  };
  /**
   * A message from the phone. With no turn running: its row, then the default turn. While one runs it waits in the chat's queue
   * (as the Mac's does: the phone sees it in session.queue) and goes when the turn completes; a Stop keeps it there, and a new
   * message sent after the Stop starts a turn at once, ahead of what was held.
   */
  const queue = (/** @type {any} */ chat, /** @type {string} */ text, /** @type {{ images: string[], clientId?: string }} */ sent) => {
    if ((chat.pending ?? 0) === 0) return say(chat, text, sent);
    const id = `queued-${++counter}`;
    const { images, clientId } = sent;
    pics.keep(chat.id, id, images);
    const held = {
      id,
      text,
      attachments: [],
      ...(images.length ? { images: images.length } : {}),
      ...(clientId ? { nativeId: clientId } : {}),
      opts: { human: true },
    };
    state.patch(chat.id, { queue: [...state.get(chat.id).queue, held] });
  };

  function add(
    /** @type {{ id: string, title: string, harness: string, at: number, project?: string | null, projectId?: string | null, account?: string, accountDefault?: boolean, projectPath?: string, hidden?: boolean, unlisted?: boolean, parentId?: string, ended?: string }} */ c,
  ) {
    const chat = { project: null, pinned: false, rows: [], tail: Promise.resolve(), epoch: 0, ...c };
    chats.set(chat.id, chat);
    return chat;
  }
  for (const seed of seeds) {
    const chat = add({
      id: seed.id,
      title: seed.title,
      harness: seed.harness,
      at: now() - seed.ago,
      project: seed.project,
      projectPath: seed.projectPath,
      account: seed.account,
      parentId: seed.parentId,
      ended: seed.ended,
    });
    for (const [role, text, extra] of /** @type {[string, string, { images?: string[] }?][]} */ (seed.rows))
      row(chat, role, text, undefined, extra);
    if (seed.waiting) {
      raise(chat, seed.waiting);
      // an old ask nothing is running behind: an answer or a Stop just closes it
      const old = { abort: new AbortController(), answer: () => (turns.delete(chat.id), clear(chat, 'idle')) };
      old.abort.signal.addEventListener('abort', () => old.answer());
      turns.set(chat.id, old);
    }
  }

  /** A card in the chat, by id, or undefined before one. */
  const cardIn = (/** @type {string} */ chatId, /** @type {string | number} */ id) =>
    (cards.get(chatId) ?? []).find((c) => c.id === id) ?? null;
  /** An answer to the chat's card from a phone; false when the card is gone. */
  function answerCard(
    /** @type {string} */ chatId,
    /** @type {string | number} */ id,
    /** @type {string} */ key,
    /** @type {unknown} */ values = null,
  ) {
    const turn = turns.get(chatId);
    if (turn) turn.values = values;
    if (!cardIn(chatId, id) || !settle(chatId, key)) return false;
    log(`app: ${chatId} card ${id} answered "${key}"`);
    return true;
  }
  const known = (/** @type {string} */ id) => chats.has(id);
  const surfaces = createSurfaces();
  const ops = {
    surface: async (/** @type {string} */ chatId) => surfaces.of(chatId),
    recent: async (/** @type {number} */ limit, /** @type {boolean} */ archived = false, /** @type {number} */ offset = 0) =>
      recentRows(chats.values(), { limit, archived, offset }),
    turn: (/** @type {string} */ id) => (known(id) ? state.get(id)?.turn : undefined),
    projects: () => [{ id: 'dev-repo', name: 'dev-repo' }],
    scheduled: async () =>
      SCHEDULED.map(({ id, name, in: soon, hostId, firesWhileMacAway }) => ({
        id,
        name,
        next: soon === null ? null : now() + soon,
        ...(hostId && { hostId, firesWhileMacAway }),
      })),
    pin: (/** @type {string} */ id, /** @type {boolean} */ pinned) => known(id) && ((chats.get(id).pinned = pinned), true),
    // the sidebar's Rename and Archive and the Side chat, from a phone (electron/remote/methods/chatsManage.cjs)
    ...fakeChatOps({ chats, add, log, now }),
    usage: async () => fakeUsage(now()),
    ...accountOps,
    harnesses: async () => HARNESSES,
    usable: async (/** @type {string} */ _harness) => true,
    // the menus show what was chosen for the chat (a model's own default effort when none was), as the real app's
    // and name the agent the chat runs on, as the real app's menus do (`harnessId`, `harness`): the phone's agent switch and a machine's reason a chat cannot move there read it
    options: async (/** @type {any} */ target) => {
      const id = moves.shownFor(target.chatId ?? '') ?? target.harness;
      const menus = optionsOf(target, picked.get(target.chatId ?? '') ?? {}, menuOf, models.list());
      // a move that waits is named, as the Mac's menus do
      return id
        ? { ...menus, harnessId: id, harness: HARNESSES.find((h) => h.id === id)?.label ?? id, switching: moves.held(target.chatId ?? '') }
        : menus;
    },
    // a Codex chat takes skills beside its text, any other chat's commands go in the text (as the real app's menus)
    commands: async (/** @type {any} */ target) => ({
      commands: COMMANDS[(chats.get(target.chatId)?.harness ?? target.harness) === 'codex' ? 'skill' : 'text'],
    }),
    choose: async (/** @type {any} */ p) => {
      picked.set(p.chatId ?? '', { ...picked.get(p.chatId ?? ''), model: p.model, effort: p.effort ?? null });
      log(`app: model ${p.model} effort ${p.effort}`);
    },
    permit: async (/** @type {any} */ p) => {
      picked.set(p.chatId ?? '', { ...picked.get(p.chatId ?? ''), permission: p.value });
      log(`app: permission ${p.value}`);
    },
    switchHarness: moves.switchHarness,
    dictation: createFakeDictation(log),
    // an id the Mac's schema accepts (16 hex digits), so a message that carries attachments is not refused; the name is kept for the log line of the send
    attach: (/** @type {any} */ f) => {
      const id = (++counter).toString(16).padStart(16, '0');
      attached.set(id, f.name);
      pics.remember(id, f.dataUrl);
      return { id, name: f.name, kind: 'file' };
    },
    browserSettings: () => ({ ok: true }),
    start: async (/** @type {any} */ m) => {
      const chat = add({
        id: `dev-chat-${++counter}`,
        title: String(m.text).split('\n')[0].slice(0, 60) || 'New chat',
        harness: m.harness,
        at: now(),
        project: m.projectId ?? null,
      });
      if (m.account) accountOps.setChatAccount({ chatId: chat.id, account: m.account }); // the pin, as the Mac applies it once the chat exists
      queue(chat, m.text, { images: pics.of(m.attachments), clientId: m.nativeMessageId });
      return { chatId: chat.id };
    },
    open: () => undefined,
    read: async (/** @type {string} */ id) => {
      if (!known(id)) throw new Error(GONE);
      return { chatId: id, rows: chats.get(id).rows };
    },
    /** The page of rows before `before`, newest last, as the Mac's history pages back for a phone; null when that row is not in the chat. */
    older: async (/** @type {string} */ id, /** @type {string} */ before, limit = 40) => {
      // like the Mac's: a chat that is not reachable (MoMo's hidden chat) is gone
      if (!ops.reachable(id)) throw new Error(GONE);
      const rows = chats.get(id).rows;
      const at = rows.findIndex((/** @type {{ id: string }} */ r) => r.id === before);
      if (at < 0) return null;
      const start = Math.max(0, at - limit);
      return { rows: rows.slice(start, at), more: start > 0 };
    },
    send: async (/** @type {any} */ p) => {
      if (!known(p.chatId)) throw new Error(GONE);
      moves.settle(p.chatId, row);
      if (p.attachments?.length) log(`app: send carries ${p.attachments.map((id) => attached.get(id) ?? id).join(', ')}`);
      queue(chats.get(p.chatId), p.text, { images: pics.of(p.attachments), clientId: p.nativeMessageId });
      return { warning: null };
    },
    userImage: (/** @type {string} */ chatId, /** @type {string} */ itemId, /** @type {number} */ index) =>
      pics.read(chatId, itemId, index),
    // the app's Remove on a queued message of the user's
    unqueue: (/** @type {string} */ id, /** @type {string} */ qid) => {
      const waiting = state.get(id).queue;
      if (!waiting.some((/** @type {{ id: string }} */ q) => q.id === qid)) return false;
      state.patch(id, { queue: waiting.filter((/** @type {{ id: string }} */ q) => q.id !== qid) });
      return true;
    },
    // nothing here is kept for a machine's Host: there is nothing to send again
    requeue: async (/** @type {string} */ _id, /** @type {string} */ _qid) => null,
    stop: async (/** @type {string} */ id) => {
      turns.get(id)?.abort.abort();
      const chat = chats.get(id);
      if (chat) chat.epoch++;
    },
    answer: async (/** @type {any} */ p) => answerCard(p.chatId, p.approvalId, p.choice, p.values ?? null),
    state,
    // MoMo's hidden chat is reached through the momo.* methods only
    reachable: (/** @type {string} */ id) => known(id) && !chats.get(id).hidden,
    cardsOf: async (/** @type {string} */ id) => cards.get(id) ?? [],
    items: feed.items,
    // the @ menu: the other fake chats, and the files of the repository the fake works in (the real ranking)
    mentionsList: (/** @type {{ chatId: string, query: string }} */ p) =>
      createPanelAt({ recent: (limit, archived) => ops.recent(limit, archived), cwdOf: async () => repo, ...(search && { search }) })(p),
    // the same menu before a chat exists: the repository stands in for any saved project
    mentionsStart: (/** @type {{ harness: string, projectId: string | null, query: string }} */ p) =>
      createPanelStartAt({ recent: (limit, archived) => ops.recent(limit, archived), projectCwd: () => repo, ...(search && { search }) })(
        p,
      ),
  };
  return {
    ops: moves.slow(ops),
    chats,
    /** Gives the app the service it publishes patches and feed events to (made after the ops). */
    bind(/** @type {any} */ s) {
      service = s;
    },
    /** The pieces scenarios build on: make a chat, run a script in it, answer its card as the Mac. */
    add,
    row,
    cardIn,
    answerCard,
    enqueue,
    runScript,
    setSurface: surfaces.set,
    /** The Mac's user answers the chat's card (only that card, when its id is given); false when none is up. */
    macAnswers(/** @type {string} */ chatId, /** @type {string} */ key, /** @type {string | undefined} */ cardId = undefined) {
      if (cardId !== undefined && cards.get(chatId)?.[0]?.id !== cardId) return false;
      if (!settle(chatId, key)) return false;
      log(`app: ${chatId} card answered on the Mac with "${key}"`);
      return true;
    },
    /** The next `count` reads of any chat fail with `message`, so a phone opening a chat gets an error to retry from. */
    failReads(/** @type {number} */ count, /** @type {string} */ message) {
      readFailures.left = count;
      readFailures.message = message;
    },
    /** The model menu gets `count` more models (0 puts it back). */
    moreModels: models.set,
    counter: () => ++counter,
    /** Waits until every chat's scripted turn has ended. */
    idle: () => Promise.all([...chats.values()].map((c) => c.tail)),
  };
}
