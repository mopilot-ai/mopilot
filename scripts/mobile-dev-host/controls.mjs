// DEV ONLY: the host's own switches a bench scenario flips: MoMo on or off for the account, the Mac's brain-change setting, chat titles in push, the Mac sleeping or dropping off the network, the relay restarting, the Mac removing a paired phone, the Mac's send counter running ahead, and the Mac asking the relay to push to a phone.
import { PUSH_KINDS } from '../../relay/src/frames.mjs';
import { TITLES } from '../../relay/src/notifier.mjs';
import { apnsBody } from '../../relay/src/pushPayload.mjs';
import { chatRef } from '../../shared/remote/ref.mjs';
import { momoPushBody } from '../../shared/momoNotices.mjs';

/** The cards `momo-recipients` raises. */
const RECIPIENT_SHAPES = ['three', 'many', 'blocked', 'off'];

/** @typedef {{ momo: boolean, brain: boolean, tasks: boolean, tasksFailed?: boolean, tasksEmpty?: boolean, voice: string, shell?: boolean, channels?: boolean, echoMs?: number, pushBody?: boolean, suggestions?: string, brief?: string }} Bench tasks: whether the Mac lists momo.tasks.list in its hello; tasksFailed: its read fails; tasksEmpty: it has no task at all; voice: `off` (momo.chat.transcribe not listed), `on`, `fail` or `empty` (what a MoMo voice note comes back as); shell: the Mac has MoMo's page shell on; echoMs: the Mac records a MoMo send that long after taking it (momo-late-echo); pushBody: the Mac's opt-in for MoMo's push body (A6) */

/**
 * @param {object} o
 * @param {Bench} o.bench what MoMo is allowed to do, read by the service on every call
 * @param {() => { state: string, setPresence(state: 'online' | 'sleeping'): void } | null} o.relayClient the Mac's relay connection (null while Mobile Remote is off)
 * @param {(ms: number) => void} o.cutMac closes the Mac's socket at the relay and refuses its reconnects for `ms`, as a network outage does
 * @param {(title?: string) => Promise<string>} [o.momoRemind] MoMo raises a reminder in its chat (the loop id comes back)
 * @param {(shape: string) => Promise<string>} [o.momoDraft] puts a draft MoMo wrote in its chat (or takes them out)
 * @param {(shape: string) => Promise<string>} [o.momoOptions] puts a question with answer chips in its chat as the last reply (or takes them out)
 * @param {(shape: string) => Promise<string>} [o.momoReport] puts a routine's report or the setup greeting in its chat, as the Mac sends it (or takes them out)
 * @param {(shape: string) => Promise<string>} [o.momoRecipientsCard] puts a send's approval card with its recipients up in MoMo's chat (its title comes back)
 * @param {(mode: 'on' | 'empty') => Promise<void>} [o.momoSuggestions] fills MoMo's Up next with made-up suggestions (on) or empties it
 * @param {(mode: 'on' | 'off' | 'failed') => Promise<void>} [o.momoBrief] the morning brief on (its row and its stack in MoMo's chat), failed (it could not start) or off
 * @param {() => Promise<boolean>} [o.momoTaskCard] puts an approval card up in MoMo's chat for the Tasks list (false when it is up already)
 * @param {(on: boolean) => void} o.momoSwitched told when MoMo is turned on or off (a phone following MoMo's chat is dropped when it goes off)
 * @param {(n: number, pairId?: string) => Promise<string>} o.advanceCounters moves the Mac's send counter for the paired phones n frames on (gap.mjs)
 * @param {(downMs: number) => Promise<void>} o.restartRelay stops the relay, waits, and starts it again on the same port and database
 * @param {() => { id: string, name: string, pairId: string }[]} o.devices
 * @param {(deviceId: string, pairId: string) => Promise<boolean>} o.unpair the Mac removes a paired phone
 * @param {(area: 'memory' | 'routines' | 'brain' | 'prefs' | 'chat' | 'sources') => void} o.changed tells the phones MoMo changed
 * @param {(ms: number, fn: () => void) => unknown} o.after
 * @param {() => { hostLinked: boolean }} [o.linkState] whether the relay holds a Host connection (the assisted s3 run refuses to ask a person until a push can leave)
 * @param {(req: { pair: string, kind: string, ref: string, sealed?: string, card?: string }) => Promise<string>} o.pushRequest the Mac's push request to the relay (resolves with its status)
 * @param {(pair: string, ref: string, title: string) => string | null} o.seal a chat title sealed for a phone, or null while titles in push are off
 * @param {(pair: string, ref: string, text: string) => string | null} [o.sealBody] MoMo's push body sealed for a phone, or null while the opt-in is off or the phone has no key yet (asking hands it the key)
 * @param {(on: boolean) => Promise<void>} o.setTitles the Mac's opt-in for chat titles in push (off: the fixed text; on: each push carries the title sealed for the phone)
 * @param {(chatId: string) => string | null} o.chatTitle a chat's title, or null for a chat that is not there
 * @param {(text: string) => void} o.log
 * @param {{ toggle: () => boolean, setAgent: (machine: string, agent: string, state: string) => void, changed: () => unknown, direct: (pairId: string, on: boolean) => Promise<void>, card: (text?: string) => Promise<string>, waitCard: (chatId: string, limitMs: number) => Promise<{ gone: boolean, ms: number }>, answer: (kind: 'allow' | 'deny') => Promise<number>, status: () => Promise<string>, chat: (harness: 'fake' | 'claude' | 'codex', text: string) => Promise<string> } | null} [o.hosts] the made-up machines (--fake-hosts), and the service told they changed
 */
export function createControls({
  bench,
  relayClient,
  cutMac,
  restartRelay,
  advanceCounters,
  devices,
  unpair,
  changed,
  after,
  log,
  momoSwitched,
  momoRemind = async () => {
    throw new Error('MoMo is not running.');
  },
  momoTaskCard = async () => false,
  momoSuggestions = async () => undefined,
  momoBrief = async () => undefined,
  momoDraft = async () => {
    throw new Error('MoMo is not running.');
  },
  momoOptions = async () => {
    throw new Error('MoMo is not running.');
  },
  momoReport = async () => {
    throw new Error('MoMo is not running.');
  },
  momoRecipientsCard = async () => {
    throw new Error('MoMo is not running.');
  },
  pushRequest,
  linkState = () => ({ hostLinked: true }),
  seal,
  sealBody = () => null,
  setTitles,
  chatTitle,
  hosts = null,
}) {
  // only the latest sleep wakes the Mac: an earlier timer must not end a later sleep
  let sleeps = 0;
  const word = (/** @type {boolean} */ on) => (on ? 'on' : 'off');
  const client = () => {
    const found = relayClient();
    if (!found) throw new Error('Mobile Remote is not running.');
    return found;
  };
  /**
   * The sealed body the Mac would send `phone` for a routine's name (as its opt-in and the routine's approval would let it): the blob the phone's extension opens.
   * @throws when there is none: not a momoNeedsYou, the opt-in is off, the name shapes to nothing, or the phone has no key yet
   */
  const bodyFor = (
    /** @type {string} */ kind,
    /** @type {string} */ pair,
    /** @type {string} */ ref,
    /** @type {string} */ routineName,
  ) => {
    const text =
      kind === 'momoNeedsYou' ? momoPushBody({ optIn: bench.pushBody === true, routine: { name: routineName, approved: true } }) : '';
    const sealedBody = text ? sealBody(pair, ref, text) : null;
    if (!sealedBody)
      throw new Error(
        'No body: it is for momoNeedsYou, needs push-body on, and the phone needs its key (run push-body on, then this again).',
      );
    return sealedBody;
  };
  return {
    /** MoMo allowed (or not) for the account, as the server's invite decides it; the phone sees it in machine.hello. */
    momo(/** @type {boolean} */ on) {
      bench.momo = on;
      momoSwitched(on);
      log(`bench: MoMo ${word(on)} for this account`);
      changed('brain');
      return `MoMo is ${word(on)}: the phone learns it at its next machine.hello (reconnect or reopen the MoMo tab)`;
    },
    /**
     * Whether the Mac lists momo.tasks.list in its hello: on shows the phone's Tasks, off is an older Mac. On also puts a
     * card up in MoMo's chat, once, so the list has one of every kind; `failed` lists it but fails the read, `empty` lists it with no task in any tab.
     */
    async momoTasks(/** @type {boolean | 'failed' | 'empty'} */ mode) {
      const on = mode !== false;
      bench.tasks = on;
      bench.tasksFailed = mode === 'failed';
      bench.tasksEmpty = mode === 'empty';
      const raised = on && mode !== 'empty' && (await momoTaskCard());
      log(`bench: the Mac ${on ? 'lists' : 'does not list'} momo.tasks.list${bench.tasksFailed ? ', and its read fails' : ''}`);
      return `momo.tasks.list is ${word(on)}${bench.tasksFailed ? ' (reading fails: the phone says it could not read its tasks)' : ''}${bench.tasksEmpty ? ' (no tasks at all: every tab shows its empty line)' : ''}${raised ? ' (a card is up in MoMo’s chat)' : ''}${bench.momo ? '' : ' (MoMo itself is off: run momo on)'}: the phone learns it at its next machine.hello (reconnect or reopen the MoMo tab)`;
    },
    /**
     * Whether the Mac lists momo.suggestions.list and .act: `on` fills Up next with three made-up suggestions, `empty` lists the methods
     * with none, `off` is an older Mac that lists neither. Start sends the first step into MoMo's chat, as the Mac does.
     */
    async momoSuggestions(/** @type {'on' | 'off' | 'empty'} */ mode) {
      bench.suggestions = mode;
      if (mode !== 'off') await momoSuggestions(mode);
      log(`bench: the Mac ${mode === 'off' ? 'does not list' : 'lists'} momo.suggestions.*${mode === 'empty' ? ', with none' : ''}`);
      return `momo.suggestions.* is ${mode}${mode === 'on' ? ' (three made-up suggestions in Up next)' : ''}${mode === 'empty' ? ' (Up next has none)' : ''}${bench.momo ? '' : ' (MoMo itself is off: run momo on)'}: the phone learns it at its next machine.hello (reconnect or reopen the MoMo tab)`;
    },
    /**
     * The morning brief: `on` shows its Scheduled row and writes it into MoMo's chat once, `failed` shows "Couldn't start" with its reason and
     * Try again (which writes it), `off` is a Mac without it (momo.brief.runNow is not listed).
     */
    async momoBrief(/** @type {'on' | 'off' | 'failed'} */ mode) {
      bench.brief = mode;
      await momoBrief(mode);
      log(`bench: the morning brief is ${mode}`);
      return `the morning brief is ${mode}${bench.momo ? '' : ' (MoMo itself is off: run momo on)'}: the phone learns it at its next machine.hello (reconnect or reopen the MoMo tab)`;
    },
    /** A draft MoMo wrote in its chat, with Edit, Copy and Open in Mail (none sends); `off` takes them out again. */
    async momoDraft(/** @type {string} */ shape) {
      const said = await momoDraft(shape);
      return `${said}${bench.momo ? '' : ' (MoMo itself is off: run momo on)'}`;
    },
    /** A question with answer chips as MoMo's last reply (its row carries `options`); `off` takes them out again. */
    async momoOptions(/** @type {string} */ shape) {
      const said = await momoOptions(shape);
      return `${said}${bench.momo ? '' : ' (MoMo itself is off: run momo on)'}`;
    },
    /** A routine's report or the setup greeting in MoMo's chat, as the Mac sends it; `off` takes them out again. */
    async momoReport(/** @type {string} */ shape) {
      const said = await momoReport(shape);
      return `${said}${bench.momo ? '' : ' (MoMo itself is off: run momo on)'}`;
    },
    /** What a voice note for MoMo comes back as, or an older Mac that does not list the method (off). */
    momoVoice(/** @type {string} */ mode) {
      bench.voice = mode;
      log(`bench: MoMo voice notes ${mode === 'off' ? 'are not listed by the Mac' : `come back as: ${mode}`}`);
      return `momo.chat.transcribe is ${mode}${bench.momo ? '' : ' (MoMo itself is off: run momo on)'}: the phone learns it at its next machine.hello (reconnect or reopen the MoMo tab)`;
    },
    /** A send's approval card in MoMo's chat: three names, more than the card lists (many), nobody it can name (blocked), or an older Mac's (off). */
    async momoRecipients(/** @type {string} */ shape) {
      if (!RECIPIENT_SHAPES.includes(shape)) throw new Error(`Say one of ${RECIPIENT_SHAPES.join(', ')}.`);
      const title = await momoRecipientsCard(shape);
      return `MoMo asks "${title}"${bench.momo ? '' : ' (MoMo itself is off: run momo on)'}`;
    },
    /** A reminder in MoMo's chat, with Done, Snooze and Dismiss; MoMo has to be on for the phone to see it. */
    async remind(/** @type {string | undefined} */ title) {
      await momoRemind(title);
      return `MoMo raised a reminder${bench.momo ? '' : ' (MoMo itself is off: run momo on)'}`;
    },
    /**
     * The APNs body the relay would send the first paired phone for a push, to hand to `xcrun simctl push`: a simulator
     * shows it as a real notification and a tap opens the chat (and, for MoMo's needs-you, the card) as a push does.
     */
    pushPayload(
      /** @type {string} */ kind,
      /** @type {string} */ chatId,
      /** @type {string | undefined} */ cardId,
      /** @type {string | undefined} */ routineName = undefined,
    ) {
      if (!PUSH_KINDS.includes(kind)) throw new Error(`The kind must be one of ${PUSH_KINDS.join(', ')}.`);
      if (chatTitle(chatId) === null) throw new Error(`No chat ${chatId}.`);
      const [phone] = devices();
      if (!phone) throw new Error('No phone is paired.');
      const ref = chatRef(phone.pairId, chatId);
      const card = cardId ? chatRef(phone.pairId, cardId) : undefined;
      const title = TITLES[/** @type {keyof typeof TITLES} */ (kind)];
      const sealedBody = routineName === undefined ? undefined : bodyFor(kind, phone.pairId, ref, routineName);
      return JSON.stringify(
        apnsBody({
          platform: 'apns',
          token: '',
          kind,
          ref,
          title,
          count: 1,
          collapseId: ref,
          ...(card && { card }),
          ...(sealedBody && { sealedBody }),
        }),
      );
    },
    /** The old mini comes online or goes away: the phone gets machines.changed. */
    hosts() {
      if (!hosts) throw new Error('Start the host with --fake-hosts to have machines.');
      const online = hosts.toggle();
      hosts.changed();
      return `old-mini is ${online ? 'online' : 'offline'}: the phone hears machines.changed`;
    },
    /** One agent on a made-up machine is ready, missing or signed out: the phone hears machines.changed. */
    agent(/** @type {string} */ machine, /** @type {string} */ agent, /** @type {string} */ state) {
      if (!hosts) throw new Error('Start the host with --fake-hosts to have machines.');
      hosts.setAgent(machine, agent, state);
      hosts.changed();
      return `${agent} on ${machine} is ${state}: the phone hears machines.changed`;
    },
    /** The Mac's switch "Use without your Mac" for every paired phone: on, a phone may enroll with the real Host (--real-host); off, its enrollment goes. */
    async direct(/** @type {boolean} */ on) {
      if (!hosts) throw new Error('Start the host with --real-host <vm> to have a Host a phone can enroll with.');
      const phones = devices();
      if (!phones.length) throw new Error('No phone is paired.');
      for (const phone of phones) await hosts.direct(phone.pairId, on);
      hosts.changed();
      return `direct access is ${word(on)} for ${phones.map((p) => p.name).join(', ')}: the phone hears machines.changed`;
    },
    /** The real Host raises a card with the app gone: a phone enrolled with it is pushed and can answer. */
    async hostCard(/** @type {string | undefined} */ text) {
      if (!hosts) throw new Error('Start the host with --real-host <vm> to have a Host that raises cards.');
      const chatId = await hosts.card(text);
      return `the Host raised a card in ${chatId}: an enrolled phone is pushed`;
    },
    /** The real Host starts a chat on one of its agents with the app gone: the phone follows and drives it. */
    async hostChat(/** @type {'fake' | 'claude' | 'codex'} */ harness, /** @type {string} */ text) {
      if (!hosts) throw new Error('Start the host with --real-host <vm> to have a Host with chats.');
      const chatId = await hosts.chat(harness, text);
      hosts.changed();
      return `the Host started ${harness} chat ${chatId}`;
    },
    /** The real Host's agents, as its status lists them. */
    async hostStatus() {
      if (!hosts) throw new Error('Start the host with --real-host <vm> to have a Host with agents.');
      return `the Host's agents: ${(await hosts.status()) || 'none'}`;
    },
    /**
     * An assisted run for a person holding the phone: one Host card at a time, a plain-words cue for what to do, then what the Host saw (how long until the card was answered).
     * `allow` and `deny` wait for the person to answer from the notification; `elsewhere` answers on this side after a pause, so the notification should clear or say so.
     * @param {'allow' | 'deny' | 'elsewhere'} step
     */
    async s3(step) {
      if (!hosts) throw new Error('Start the host with --real-host <vm> to have a Host with cards.');
      const cues = {
        allow:
          'Lock the phone. When the notification "A chat needs you" arrives, long-press it, tap Allow and unlock with Face ID or the passcode.',
        deny: 'Lock the phone. When the notification "A chat needs you" arrives, long-press it and tap Deny.',
        elsewhere:
          'Lock the phone and do nothing: in 20 seconds this side answers the card. Then look at the notification: does it clear, or say it was answered elsewhere?',
      };
      if (!(step in cues)) throw new Error('Say allow, deny or elsewhere: run s3 allow|deny|elsewhere');
      // the owner is asked only when a push can leave: the Host is linked to the relay (without a host connection no push can leave at all)
      const link = linkState();
      if (!link.hostLinked)
        return `s3 ${step}: NOT STARTED, nobody was asked. The Host is not linked to the relay (no host connection): its enrollment is gone or not made yet, so no push can leave. Enroll the phone with the Host (the machine page's "Use without your Mac"), then run it again.`;
      const chat = await hosts.card(`PERMIT s3-${step}`);
      log(`s3 ${step}: card raised in ${chat}. ASK THE OWNER: ${cues[/** @type {keyof typeof cues} */ (step)]}`);
      if (step === 'elsewhere') {
        await new Promise((resolve) => after(20_000, () => resolve(undefined)));
        const answered = await hosts.answer('allow');
        return `s3 elsewhere: this side answered ${answered} card at +20 s; now ask what the notification shows (cleared / "answered elsewhere" / still there).`;
      }
      const seen = await hosts.waitCard(chat, 120_000);
      return seen.gone
        ? `s3 ${step}: the card was answered ${(seen.ms / 1000).toFixed(1)} s after the wait began (the push went out at the card); ask which button was tapped and whether the phone asked for Face ID or the passcode.`
        : `s3 ${step}: nobody answered within 120 s; ask what the phone showed (no notification / notification without ${step} / asked for unlock and stopped).`;
    },
    /** The app answers the Host's waiting cards (another client wins; the phone's card shows it). */
    async hostAnswer(/** @type {'allow' | 'deny'} */ kind) {
      if (!hosts) throw new Error('Start the host with --real-host <vm> to have a Host with cards.');
      const n = await hosts.answer(kind);
      return n ? `the app answered ${n} card${n === 1 ? '' : 's'} (${kind})` : 'the Host has no card waiting';
    },
    /** The Mac's "let my phone change the brain" setting. */
    brainSwitch(/** @type {boolean} */ on) {
      bench.brain = on;
      log(`bench: brain changes from the phone ${word(on)}`);
      changed('brain');
      return `brain changes from the phone are ${word(on)}${bench.momo ? '' : ' (MoMo itself is off: run momo on)'}`;
    },
    /** The Mac goes to sleep: presence "sleeping" for a while, the link stays. */
    sleep(/** @type {number} */ seconds) {
      const relay = client();
      relay.setPresence('sleeping');
      const mine = ++sleeps;
      log(`bench: the Mac sleeps for ${seconds}s`);
      after(seconds * 1000, () => {
        if (mine !== sleeps) return;
        relay.setPresence('online');
        log('bench: the Mac woke up');
      });
      return `the phone should show the computer as offline/sleeping; it is back in ${seconds}s`;
    },
    /** The Mac drops off the network: the relay loses its socket (presence "gone") and refuses it for a while; the Mac keeps what it sends and reconnects by itself. */
    unplug(/** @type {number} */ seconds) {
      client();
      cutMac(seconds * 1000);
      log(`bench: the Mac is off the network for ${seconds}s`);
      after(seconds * 1000, () => log('bench: the Mac may reconnect now'));
      return `the phone should show the computer as offline; the Mac reconnects by itself within a few seconds after ${seconds}s`;
    },
    /** The relay process restarting: every socket drops, its database (the mailbox in it) stays. */
    restartRelay(/** @type {number} */ seconds) {
      void restartRelay(seconds * 1000).then(
        () => log('bench: the relay restart finished'),
        (error) => log(`bench: the relay restart failed: ${error.message}`),
      );
      return `the relay is down for ${seconds}s and comes back on the same address with its mailbox; both sides reconnect by themselves`;
    },
    /** The Mac's send counter runs n frames ahead of what the phone has seen: its next frame is a catch-up (past 4096) or beyond the cap (past 131072). */
    async advanceTx(/** @type {number} */ n, /** @type {string | undefined} */ pairId = undefined) {
      const summary = await advanceCounters(n, pairId);
      log(`bench: ${summary}`);
      return `${summary}: the phone sees it on the next frame from the Mac (a chat message or run work); a phone that is closed shows it when it opens`;
    },
    /** The Mac removes a paired phone (Settings › Mobile Remote › Remove). */
    async revoke(/** @type {number} */ index) {
      // the relay carries the news to the phone: with the link down, removing the phone would leave it believing it is still paired
      if (client().state !== 'open')
        throw new Error('The Mac is not connected to the relay, so the phone would not be told. Try again when it is back.');
      const device = devices()[index - 1];
      if (!device)
        throw new Error(devices().length ? `No paired phone number ${index} (there are ${devices().length}).` : 'No phone is paired.');
      if (!(await unpair(device.id, device.pairId))) throw new Error(`The Mac could not remove ${device.name}.`);
      log(`bench: the Mac removed ${device.name}`);
      return `${device.name} was removed on the Mac: the phone should say it must pair again`;
    },
    /** The Mac's opt-in for chat titles in push: on hands each phone its title key and seals every push's title for it; off sends the fixed text. */
    async titles(/** @type {boolean} */ on) {
      client();
      await setTitles(on);
      log(`bench: chat titles in push ${word(on)}`);
      return `chat titles in push are ${word(on)}${on ? ': the phone gets its title key, then run push seals each title' : ''}`;
    },
    /** The Mac's opt-in for MoMo's push body (A6): on, a push for a routine's notice carries that routine's name sealed for the phone; off, the fixed text. Asking once hands each phone its key. */
    pushBody(/** @type {boolean} */ on) {
      bench.pushBody = on;
      if (on) for (const phone of devices()) sealBody(phone.pairId, '', 'key');
      log(`bench: MoMo's push body ${word(on)}`);
      return `MoMo's push body is ${word(on)}${on ? ': once the phone has its key, push-payload momoNeedsYou <chat> <card> <routine name> prints a body' : ''}`;
    },
    /** The Mac asks the relay to push to each paired phone, as it does when a chat needs the user (a real push when the host has APNs or FCM keys). */
    async push(
      /** @type {string} */ kind,
      /** @type {string} */ chatId,
      /** @type {string | undefined} */ routineName = undefined,
      /** @type {string | undefined} */ channelId = undefined,
      /** @type {string | undefined} */ cardId = undefined,
    ) {
      if (!PUSH_KINDS.includes(kind)) throw new Error(`The kind must be one of ${PUSH_KINDS.join(', ')}.`);
      const title = chatTitle(chatId);
      if (title === null) throw new Error(`No chat ${chatId}.`);
      client();
      const phones = devices();
      if (!phones.length) throw new Error('No phone is paired.');
      // a routine's name (MoMo's opt-in body): asked for every phone first, so a push is never half sent
      const refOf = (/** @type {{ pairId: string }} */ phone) =>
        chatRef(phone.pairId, kind === 'momoNeedsYou' && channelId ? channelId : chatId);
      const bodies = phones.map((phone) =>
        routineName === undefined ? undefined : bodyFor(kind, phone.pairId, refOf(phone), routineName),
      );
      const outcomes = await Promise.all(
        phones.map(async (phone, i) => {
          // MoMo's needs-you for a channel's card: ref is the channel's handle and card the card's, as the Mac sends them (notifyPush.cjs)
          const momo = kind === 'momoNeedsYou';
          const ref = refOf(phone);
          const sealed = momo ? null : seal(phone.pairId, ref, title);
          const card = momo && cardId ? chatRef(phone.pairId, cardId) : null;
          const sealedBody = bodies[i];
          try {
            return `${phone.name} ${await pushRequest({ pair: phone.pairId, kind, ref, ...(sealed && { sealed }), ...(card && { card }), ...(sealedBody && { sealedBody }) })}`;
          } catch (error) {
            return `${phone.name} failed (${error instanceof Error ? error.message : String(error)})`;
          }
        }),
      );
      log(`bench: push ${kind} for ${chatId}: ${outcomes.join(', ')}`);
      return `${kind} for “${title}”: ${outcomes.join(', ')}`;
    },
  };
}
