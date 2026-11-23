// DEV ONLY: MoMo as the Mac-side remote service sees it (the shape electron/remote/momoOps.cjs makes): a main chat, a few memory facts and documents, routines with a proposal waiting, and a brain with its effort, reminders, settings, sources and what MoMo learned, all in memory. MoMo's chat is a hidden chat of the fake app, so it streams and asks like any other.
import { createRequire } from 'node:module';
import { raiseDraft } from './fakeMomoDraft.mjs';
import { raiseOptions } from './fakeMomoOptions.mjs';
import { raiseReport } from './fakeMomoReport.mjs';
import { createFakeTaskPanel } from './fakeMomoTasks.mjs';

const require = createRequire(import.meta.url);
const { RemoteError } = require('../../electron/remote/serviceErrors.cjs');
const { deriveTasks } = require('../../electron/momo/tasks.cjs');
const { momoActionCard } = require('../../electron/remote/momoCard.cjs');
const DAY = 86_400_000;
/** What a voice note says when the fake Mac hears it, and what it says when the speech services give up. */
export const VOICE_TEXT = 'Remind me to call the bank on Friday.';
const VOICE_FAILED = 'Speech services did not respond. Dictate again.';

/**
 * The fake app's dictation with MoMo's voice note answered as `mode` says (the scenario `momo-voice`): `on` hears VOICE_TEXT, `fail`
 * is a speech failure, `empty` hears nothing. The coding chat's own transcribe is left to the fake app. A MoMo note is the one that asks not to be kept.
 * @param {any} dictation @param {() => string} mode
 */
export function voiceOps(dictation, mode) {
  return {
    ...dictation,
    transcribeClip: async (/** @type {{ keep?: boolean }} */ clip) => {
      if (clip.keep !== false) return dictation.transcribeClip(clip);
      if (mode() === 'fail') throw new Error(VOICE_FAILED);
      return { text: mode() === 'empty' ? '' : VOICE_TEXT };
    },
  };
}
/** What the Mac says when Run now meets a pause (electron/remote/momoOps.cjs). */
const PAUSED = 'MoMo is paused. Resume it first.';
/** MoMo's main chat. */
export const MAIN_CHAT = 'dev-momo-main';
const MAIN = MAIN_CHAT;

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./fakeApp.mjs').createFakeApp>} o.app
 * @param {() => boolean} o.brainChangeAllowed whether the Mac lets a phone change the brain
 * @param {(area: 'memory' | 'routines' | 'brain' | 'prefs' | 'chat' | 'sources') => void} o.changed tells the phones which part changed
 * @param {() => number} [o.now]
 * @param {() => boolean} [o.tasksPanel] whether the Mac has the four-tab Tasks panel on (momo-tasks on, failed)
 * @param {() => (import('../../electron/momo/tasksPanel.cjs').BriefRow | null)} [o.brief] the morning brief's Scheduled row, null while it is off (fakeMomoBrief.mjs)
 * @param {() => boolean} [o.suggestions] whether the Mac has its suggestions flag on, which `momo.state.get` says (momo-suggestions on or empty)
 * @param {() => boolean} [o.tasksEmpty] whether the Mac has no tasks at all (momo-tasks empty)
 * @param {() => boolean} [o.tasksFailing] whether reading the tasks fails (momo-tasks failed)
 * @param {any} [o.channels] MoMo's channels (A2), as the fake Mac keeps them (fakeMomoChannels.mjs): the chat methods may name one and momo.channels.* answer from it
 * @param {() => boolean} [o.shell] whether the Mac has MoMo's page shell on (momo-shell on): its state then says so, as the Mac's does
 */
/** The Mac's `momo` card params for a send, by scenario: three names, more than the card lists, nobody it can name, or an older Mac with no count. */
export function recipientsParams(/** @type {string} */ shape) {
  const base = {
    action: 'change',
    source: 'Mail',
    account: 'work',
    summary: 'Send the weekly summary',
    hosts: [],
    unknown: false,
    denyAlways: true,
  };
  const names = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => `person${i + 1}@example.com`);
  if (shape === 'blocked') return { ...base, scopes: [], denyAlways: false, recipients: [], recipientCount: 0, blocked: 'no-recipients' };
  if (shape === 'many') return { ...base, scopes: ['once', 'chat'], recipients: names(20), recipientCount: 23, blocked: '' };
  // an older Mac sends a name or two and no count or reason
  if (shape === 'off') return { ...base, scopes: ['once', 'chat'], recipients: names(1) };
  return { ...base, scopes: ['once', 'chat'], recipients: names(3), recipientCount: 3, blocked: '' };
}

/** The `channels` option (A2): MoMo's channels as the fake Mac keeps them (fakeMomoChannels.mjs); the chat methods may name one and momo.channels.* answer from it. */
export function createFakeMomo({
  app,
  brainChangeAllowed,
  changed,
  now = Date.now,
  tasksPanel = () => false,
  tasksFailing = () => false,
  shell = () => false,
  tasksEmpty = () => false,
  brief = () => null,
  suggestions = () => false,
  channels = /** @type {any} */ (null),
}) {
  const facts = [
    { id: 'f1', text: 'Likes green tea in the morning', expiresAt: null },
    { id: 'f2', text: 'Release notes go out on Thursdays', expiresAt: null },
    { id: 'f3', text: 'Flight to Lisbon on the 3rd', expiresAt: now() - 86_400_000 },
  ];
  const docs = { aboutYou: 'Du builds MoPilot. Prefers short answers.', persona: 'Calm, brief, practical.', unreadable: [] };
  const routines = [
    { id: 'r1', name: 'Morning brief', schedule: 'Weekdays 08:30', paused: false },
    { id: 'r2', name: 'Weekly cleanup', schedule: 'Fridays 17:00', paused: true },
  ];
  /** @type {{ id: string, name: string, prompt: string, schedule: string, sources: string, rev: number }[]} */
  const proposals = [
    {
      id: 'p1',
      name: 'Inbox digest',
      prompt: 'Summarize new mail twice a day.',
      schedule: 'Daily 12:00 and 18:00',
      sources: 'Mail',
      rev: 1,
    },
  ];
  /** @type {{ harness: string, account: string | null, model: string, modelLabel: string, effort?: string | null }} */
  let brain = { harness: 'codex', account: null, model: 'dev-fast', modelLabel: 'Dev Fast', effort: null };
  /** MoMo's settings as `momo.prefs.get` gives them. */
  const prefs = {
    paused: false,
    proactivity: 'default',
    /** @type {{ start: string, end: string } | null} */
    quietHours: null,
    levels: [{ id: 'off' }, { id: 'low' }, { id: 'default' }, { id: 'high' }],
  };
  /** Whether Calendar and Reminders are connected on the Mac. */
  const sources = { calendar: true, reminders: false };
  /** @type {Map<string, { loopId: string, title: string, quote: string | null, why: string | null }>} reminders still open */
  const loops = new Map();
  let reminded = 0;
  /** What MoMo learned, newest first, and the facts a newer one replaced. */
  /** @type {any[]} */
  const changes = [
    {
      id: 'c2',
      op: 'update',
      by: 'pass',
      at: now() - 3_600_000,
      undoable: true,
      items: [{ before: { text: 'Release notes go out on Fridays' }, after: { text: 'Release notes go out on Thursdays' } }],
    },
    {
      id: 'c1',
      op: 'save',
      by: 'user',
      at: now() - 7_200_000,
      undoable: false,
      items: [{ after: { text: 'Likes green tea in the morning' } }],
    },
  ];
  /** @type {{ id: string, text: string, quote: string, state: string, saidAt: number, dueAt?: number, snoozedUntil?: number }[]} the open loops the Tasks list shows, besides the reminders: one awake, one snoozed out of the list */
  const taskLoops = [
    {
      id: 'tl1',
      text: 'Renew the lease',
      quote: 'I need to renew the lease by Friday',
      state: 'open',
      saidAt: now() - 2 * DAY,
      dueAt: now() + 2 * DAY,
    },
    {
      id: 'tl2',
      text: 'Call the bank',
      quote: 'remind me to call the bank',
      state: 'open',
      saidAt: now() - DAY,
      snoozedUntil: now() + 3 * DAY,
    },
  ];
  /** The routine run that is going. */
  const runs = [{ chatId: 'dev-run-1', taskId: 'r1', startedAt: now() - 5 * 60_000 }];
  const taskPanel = createFakeTaskPanel({
    now,
    routines,
    loops: taskLoops,
    paused: () => prefs.paused,
    failing: tasksFailing,
    empty: tasksEmpty,
    brief,
    cards: async () => [...(app.chats.has(MAIN) ? await app.ops.cardsOf(MAIN) : []), ...(channels ? await channels.waitingCards() : [])],
    changed,
  });
  /** Whether the approval card for the Tasks list was raised in MoMo's chat. */
  let taskCard = false;
  const past = [{ id: 'x1', text: 'Release notes go out on Fridays' }];

  /** @type {Set<string>} */
  const sent = new Set();
  const found = (/** @type {string} */ id) => {
    const fact = facts.find((f) => f.id === id);
    if (!fact) throw new Error('That fact is not in MoMo’s memory.');
    return fact;
  };
  const routine = (/** @type {string} */ id) => {
    const r = routines.find((x) => x.id === id);
    if (!r) throw new Error("That isn't one of MoMo's routines.");
    return r;
  };

  /** MoMo's main chat, made when there is none (hidden from the chat list). */
  const mainChatId = async () => {
    if (!app.chats.has(MAIN)) {
      const chat = app.add({ id: MAIN, title: 'MoMo', harness: 'claude', at: now(), hidden: true });
      app.row(chat, 'assistant', 'Hi, I am MoMo. Ask me anything.');
    }
    return MAIN;
  };

  /** The reminder rows MoMo keeps in its chat, each with the loop its buttons act on. */
  const remind = async (/** @type {string} */ title = `Reminder ${reminded + 1}`) => {
    const chat = app.chats.get(await mainChatId());
    const loopId = `loop${++reminded}`;
    const nudge = { loopId, title, quote: 'Send the release notes to the team.', why: 'You said you would on Thursday.' };
    loops.set(loopId, nudge);
    chat.rows.push({ role: 'note', text: title, nudge, at: now(), id: `${chat.id}-r${chat.rows.length + 1}` });
    changed('chat');
    return loopId;
  };
  const loop = (/** @type {string} */ id) => {
    const found = loops.get(id);
    if (!found) throw new Error('That reminder is already closed.');
    return found;
  };

  /** A draft MoMo wrote (or none, `off`) as a row in MoMo's chat (fakeMomoDraft.mjs). */
  const draft = async (/** @type {string} */ shape) => {
    const said = raiseDraft(shape, app.chats.get(await mainChatId()), now);
    changed('chat');
    return said;
  };

  /** A question with answer chips (or none, `off`) as the last reply row in MoMo's chat (fakeMomoOptions.mjs). */
  const options = async (/** @type {string} */ shape) => {
    const said = raiseOptions(shape, app.chats.get(await mainChatId()), now);
    changed('chat');
    return said;
  };

  /** A routine's report or the setup greeting (or none, `off`) as a row in MoMo's chat (fakeMomoReport.mjs). */
  const report = async (/** @type {string} */ shape) => {
    const said = raiseReport(shape, app.chats.get(await mainChatId()), now);
    changed('chat');
    return said;
  };

  /** A send's approval card in MoMo's chat, as the Mac's card for a phone makes it (electron/remote/momoCard.cjs). */
  const recipientsCard = async (/** @type {string} */ shape) => {
    const chat = app.chats.get(await mainChatId());
    const card = momoActionCard(recipientsParams(shape));
    void app.enqueue(chat, async (t) => {
      await t.ask({ title: card.title, detail: card.detail, choices: card.choices });
      await t.say('Done.');
    });
    changed('chat');
    return card.title;
  };

  return {
    mainChatId,
    /** The chat a request reaches: MoMo's main chat, or a channel's (A2). */
    chatFor: async (/** @type {string | undefined} */ channelId, make = true) =>
      channelId === undefined || !channels ? mainChatId() : channels.chatId(channelId, make),
    channels,
    recipientsCard,
    remind,
    draft,
    options,
    report,
    /** MoMo's name, whether it is paused, and the cards (and open reminders) that wait for the user. */
    state: async () => ({
      name: 'MoMo',
      color: 'orange',
      status: prefs.paused ? 'paused' : 'online',
      needsYou: app.chats.has(MAIN) ? (await app.ops.cardsOf(MAIN)).length : 0,
      ...(shell() ? { shell: true, shellTasks: tasksPanel() } : {}),
      ...(suggestions() ? { suggestions: true } : {}),
    }),
    /** MoMo is allowed here whenever the host's switch let the request through (the service refused it otherwise). */
    assertAllowed: () => undefined,
    /** Run now starts MoMo's own work, which a pause holds. */
    awake: () => {
      if (prefs.paused) throw new RemoteError('forbidden', PAUSED);
    },
    // a send the phone retries (after a dropped link) carries the same id and runs once
    send: async (/** @type {string} */ chatId, /** @type {{ id: string, text: string }} */ p) => {
      if (!sent.has(p.id)) {
        sent.add(p.id);
        await app.ops.send({ chatId, text: p.text });
      }
      return null;
    },
    stop: (/** @type {string} */ chatId) => app.ops.stop(chatId),
    cardOf: (/** @type {string} */ chatId, /** @type {string} */ id) => app.cardIn(chatId, id),
    // settled in the chat that raised the card (MoMo's main chat or a channel's), never in main's by default
    answerCard: (/** @type {{ id: string }} */ approval, /** @type {string} */ key) =>
      app.answerCard([...app.chats.keys()].find((id) => app.cardIn(id, approval.id)) ?? MAIN, approval.id, key),
    memory: {
      list: async () => ({ facts: [...facts], now: now() }),
      search: async (/** @type {string} */ query) => ({
        facts: facts.filter((f) => f.text.toLowerCase().includes(query.toLowerCase())),
        now: now(),
      }),
      edit: async (/** @type {string} */ factId, /** @type {string} */ text) => {
        const fact = found(factId);
        fact.text = text;
        changed('memory');
        return { fact };
      },
      forget: async (/** @type {string} */ factId) => {
        found(factId);
        facts.splice(0, facts.length, ...facts.filter((f) => f.id !== factId));
        changed('memory');
        return {};
      },
      docs: async () => ({ ...docs }),
      changes: async () => ({ changes: [...changes] }),
      /** Takes a change back: the fact returns to what it said before. */
      undo: async (/** @type {string} */ changeId) => {
        const change = changes.find((c) => c.id === changeId);
        if (!change?.undoable || change.undone !== undefined) throw new Error('That change can no longer be undone.');
        change.undone = now();
        for (const { before, after } of change.items) {
          const fact = facts.find((f) => f.text === after?.text);
          if (fact && before) fact.text = before.text;
        }
        changed('memory');
        return { undone: true };
      },
      past: async () => ({ facts: [...past] }),
      writeAboutYou: async (/** @type {string} */ text) => {
        docs.aboutYou = text;
        changed('memory');
      },
    },
    sources: { status: async () => ({ ...sources }) },
    tasks: {
      mark: (/** @type {string} */ taskId, /** @type {string} */ mark, /** @type {string | undefined} */ undoToken = undefined) =>
        taskPanel.mark(taskId, mark, undoToken),
      /** The Mac's own derivation (momo/tasks.cjs) over what this fake keeps: a routine run, the loops and reminders, and the cards waiting; the four tabs' rows (tasksPanel.cjs) when the panel is on. */
      list: async () => {
        if (tasksPanel()) return taskPanel.list();
        const cards = [...(app.chats.has(MAIN) ? await app.ops.cardsOf(MAIN) : []), ...(channels ? await channels.waitingCards() : [])];
        const reminders = [...loops.values()].map((l) => ({
          id: l.loopId,
          text: l.title,
          quote: /** @type {string} */ (l.quote),
          state: 'open',
          saidAt: now(),
        }));
        const tasks = deriveTasks({
          runs,
          routineName: (/** @type {string} */ id) => routines.find((r) => r.id === id)?.name,
          loops: [...taskLoops, ...reminders],
          cards: cards.map((c) => ({
            id: c.id,
            params: { kind: 'momoAction', momo: { summary: c.title, source: 'Mail' } },
            channel: c.channel ?? null,
            chatId: c.chatId,
          })),
          now: now(),
        });
        // as the Mac's remote ops answer: a phone is told the channel of a card, never the chat it waits in
        return { tasks: tasks.map((/** @type {any} */ { chatId: _chat, ...task }) => task), now: now() };
      },
      /** An approval card in MoMo's chat for the Tasks list to show, once. */
      async raiseCard() {
        if (taskCard) return false;
        taskCard = true;
        const chat = app.chats.get(await mainChatId());
        void app.enqueue(chat, async (t) => {
          await t.ask({ title: 'Send the weekly summary to the team?', detail: 'To: team@example.com' });
          await t.say('Done.');
        });
        changed('chat');
        return true;
      },
    },
    activity: { list: async () => ({ items: [] }) },
    loops: {
      list: async () => ({ loops: [...loops.values()] }),
      /** Done, Dismiss or Snooze closes the reminder; it is not shown again. */
      act: async (/** @type {string} */ loopId, /** @type {{ action: string, snooze?: string }} */ { action, snooze }) => {
        const task = taskLoops.find((l) => l.id === loopId && (l.state === 'open' || action === 'reopen'));
        if (task) {
          // a loop the Tasks list shows: done or dismissed it closes, snoozed it is out of the list for a day or a week
          if (action === 'snooze') task.snoozedUntil = now() + (snooze === 'week' ? 7 : 1) * DAY;
          else if (action === 'reopen') task.state = 'open';
          else Object.assign(task, { state: action === 'dismiss' ? 'dismissed' : 'done', closedAt: now() });
          changed('memory');
          return { loopId, action };
        }
        loop(loopId);
        loops.delete(loopId);
        changed('chat');
        return { loopId, action };
      },
    },
    prefs: {
      get: () => ({ ...prefs, quietHours: prefs.quietHours && { ...prefs.quietHours } }),
      /** One setting per call, as the Mac takes it; the answer is the settings after it. */
      set: (/** @type {Record<string, unknown>} */ p) => {
        Object.assign(prefs, p);
        changed('prefs');
        return { ...prefs, quietHours: prefs.quietHours && { ...prefs.quietHours } };
      },
    },
    routines: {
      list: async () => ({ proposals: [...proposals], routines: [...routines] }),
      pause: async (/** @type {string} */ id) => {
        const r = routine(id);
        r.paused = true;
        changed('routines');
        return r;
      },
      resume: async (/** @type {string} */ id) => {
        const r = routine(id);
        r.paused = false;
        changed('routines');
        return r;
      },
      approve: async (/** @type {string} */ id, /** @type {number} */ seen) => {
        const at = proposals.findIndex((p) => p.id === id);
        if (at < 0 || proposals[at].rev !== seen) throw new Error('That proposal changed. Read it again.');
        const [accepted] = proposals.splice(at, 1);
        const made = { id: `r-${accepted.id}`, name: accepted.name, schedule: accepted.schedule, paused: false };
        routines.push(made);
        changed('routines');
        return made;
      },
      edit: async (/** @type {string} */ id, /** @type {{ name?: string, prompt?: string }} */ edit) => {
        const r = routine(id);
        Object.assign(r, edit);
        changed('routines');
        return r;
      },
      /** Deletes a routine, or declines a suggested one: the same path, as on the Mac. */
      remove: async (/** @type {string} */ id) => {
        if (proposals.some((p) => p.id === id)) proposals.splice(0, proposals.length, ...proposals.filter((p) => p.id !== id));
        else {
          const gone = routine(id);
          routines.splice(0, routines.length, ...routines.filter((r) => r !== gone));
        }
        changed('routines');
      },
      run: async (/** @type {string} */ id) => {
        const { name } = routine(id);
        await app.ops.send({ chatId: await mainChatId(), text: `Run the routine "${name}" now.` });
      },
    },
    brain: {
      get: async () => ({ brain }),
      allowedToSet: brainChangeAllowed,
      set: async (/** @type {typeof brain} */ next) => {
        brain = { ...brain, ...next };
        changed('brain');
        return { brain };
      },
    },
  };
}
