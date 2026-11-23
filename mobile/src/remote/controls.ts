// The phone's client for a running chat's controls: model, effort and permission, the agent a chat moves to, pinning, renaming and archiving; each says "update your Mac" when the Mac lacks the method.
import { bad, capabilities, list, needs, readOptions, rec, str, type Capabilities, type Harness, type Options, type Owned } from './client';

/** What the Mac offers for one chat now: its menus, the agents it can move to, and which controls this Mac supports. */
export type ChatControls = {
  options: Options;
  /** The agent the chat runs on, or the one it moves to with its next message; null when the Mac does not name it (the agent switch is then left out). */
  harness: { id: string; label: string } | null;
  /** A move to another agent waits for the chat's next message. */
  switching: boolean;
  /** The agents the chat can move to: this Mac's, or for a chat on a machine that machine's, each with its state there (`unavailable`, and `detail` saying why in the machine's words). */
  harnesses: Harness[];
  /** For a chat on a machine: its name and the agent it runs on now (`harness` is the one a held move goes to); absent for a chat of this Mac or from a Mac that does not say. */
  machine?: { name: string; current: string | null };
  /** A pick of the person's is showing and the Mac has not answered it (the sheet shows it at once; see useChatControls). */
  saving?: true;
  /** While a pick shows: the agent and held move as the Mac last said them, which the pick's own change must not count as the chat changing. */
  asRead?: { agent: string | undefined; held: boolean };
  /** The person moved the chat to another agent and the menus above are still the old agent's until they are read again. */
  moved?: { from: string | undefined };
  /** Per control: the method this Mac sets it with, or null when it has none (the screen then says to update the Mac). */
  methods: {
    pick: string | null;
    permit: string | null;
    agent: boolean;
    account: boolean;
    pin: boolean;
    rename: boolean;
    archive: boolean;
    sideChat: boolean;
  };
};

/** What a control says when this Mac lacks the method behind it. */
export const UPDATE = {
  pick: 'Update MoPilot on your computer to change the model from your phone.',
  permit: 'Update MoPilot on your computer to change permissions from your phone.',
  agent: 'Update MoPilot on your computer to switch agents from your phone.',
  pin: 'Update MoPilot on your computer to pin chats from your phone.',
  /** Under a chat menu entry this Mac cannot do yet (Rename, Archive). */
  menu: 'Update MoPilot on your Mac',
  all: 'change a chat’s settings',
};
/** A Mac that did not say what it offers is tried; one that listed its methods is believed. */
const has = (caps: Capabilities, method: string) => !caps.methods || caps.methods.has(method);
/** The method that sets a model and effort on this Mac: `options.set`, else the older `card.choose`; null when it has neither. */
const pickMethod = (caps: Capabilities) => ['options.set', 'card.choose'].find((m) => has(caps, m)) ?? null;
/** The method that sets a permission on this Mac: `options.set`, else the older `card.permit`. */
const permitMethod = (caps: Capabilities) => ['options.set', 'card.permit'].find((m) => has(caps, m)) ?? null;

/** The agents of this Mac as a read of the chat's controls last got them, and when: a read soon after reuses them instead of asking again. */
export type KnownAgents = { harnesses: Harness[]; at: number };
/** How long a Mac's list of agents is reused (it changes when an agent is installed, not with a pick). */
export const AGENTS_FRESH_MS = 60_000;

/**
 * Reads a chat's menus and what this Mac lets the phone change; throws Unavailable when the Mac cannot even list them.
 * `known`: the Mac's agents from a read a moment ago, so the read after a pick is one request, not two (a chat on a machine never asks this Mac's list).
 */
export async function loadChatControls(request: Owned, chatId: string, known?: KnownAgents | null): Promise<ChatControls> {
  // a Mac that does not answer machine.hello is treated as unknown, and requests are tried
  const caps = await capabilities(request).catch((): Capabilities => ({ methods: null, ceiling: 'auto-review' }));
  needs(caps, 'options.get', UPDATE.all);
  const reply = await request('options.get', { chatId });
  const options = readOptions(reply, caps.ceiling);
  const r = rec(reply);
  const id = str(r?.harnessId);
  // switching needs the agent the chat is on: a Mac that does not name it keeps the rest of the controls
  const canSwitch = !!id && has(caps, 'chat.switch');
  const machine = machineOf(r?.machine);
  // a chat on a machine moves among that machine's agents; any other among this Mac's
  const harnesses = !canSwitch
    ? []
    : machine
      ? machine.agents
      : known && Date.now() - known.at < AGENTS_FRESH_MS
        ? known.harnesses
        : list(rec(await request('harnesses.list'))?.harnesses).flatMap((x) => {
            const h = rec(x);
            const hid = str(h?.id);
            return hid ? [{ id: hid, label: str(h?.label) ?? hid }] : [];
          });
  return {
    options,
    harness: id ? { id, label: str(r?.harness) ?? id } : null,
    switching: r?.switching === true,
    harnesses,
    ...(machine ? { machine: { name: machine.name, current: str(r?.current) } } : {}),
    methods: {
      pick: pickMethod(caps),
      permit: permitMethod(caps),
      agent: canSwitch,
      account: has(caps, 'chat.account'),
      pin: has(caps, 'chats.pin'),
      rename: caps.renameChats === true,
      archive: caps.archiveChats === true,
      sideChat: caps.sideChats === true,
    },
  };
}

/** A chat's machine as the Mac names it: its name and the agents there, each by the name the wire moves a chat with, ready or with the machine's own words for why not; null for a chat of this Mac. */
function machineOf(raw: unknown): { name: string; agents: Harness[] } | null {
  const m = rec(raw);
  const name = str(m?.name);
  if (!m || !name) return null;
  const agents = list(m.agents).flatMap((x): Harness[] => {
    const a = rec(x);
    const id = str(a?.id);
    if (!id) return [];
    const ready = a?.state === 'ready';
    return [
      { id, label: str(a?.label) ?? id, ...(ready ? {} : { unavailable: true, detail: str(a?.reason) ?? 'Not ready on this machine' }) },
    ];
  });
  return { name, agents };
}

/** Sets a chat's model and effort with the method the Mac has; the Mac applies them from the chat's next message. */
export async function setModel(request: Owned, method: string, chatId: string, model: string, effort: string | null) {
  await request(method, { chatId, model, effort });
}

/** Sets a chat's permission; the Mac refuses full access and anything above its ceiling, whatever the phone sends. */
export async function setPermission(request: Owned, method: string, chatId: string, value: string) {
  await request(method, { chatId, value });
}

/** Moves a chat to another agent with its next message; its own agent again cancels a move that waits. */
export async function switchAgent(request: Owned, chatId: string, harness: string, account?: string | null) {
  // `account`: a login of the agent it moves to, null for that agent's own choice; left out, the move names none
  await request('chat.switch', { chatId, harness, ...(account !== undefined && { account }) });
}

/** Puts a chat on one login of its agent (null: the agent's own choice again); the Mac applies it from the chat's next message and refuses a login its agent cannot use. */
export async function setChatAccount(request: Owned, chatId: string, account: string | null) {
  const r = rec(await request('chat.account', { chatId, account }));
  if (!r || (r.account ?? null) !== account) bad('the account');
}

/** Pins or unpins a chat, as the app's sidebar does. */
export async function pinChat(request: Owned, chatId: string, pinned: boolean) {
  const r = rec(await request('chats.pin', { chatId, pinned }));
  if (r?.pinned !== pinned) bad('the pin');
}

/** Renames a chat, as the app's sidebar does; resolves the title the Mac kept. */
export async function renameChat(request: Owned, chatId: string, title: string): Promise<string> {
  return str(rec(await request('chats.rename', { chatId, title }))?.title) ?? bad('the new title');
}

/** Archives a chat, as the app's sidebar does. */
export async function archiveChat(request: Owned, chatId: string) {
  const r = rec(await request('chats.archive', { chatId, archived: true }));
  if (r?.archived !== true) bad('the archive');
}

/** Starts the Mac's side chat from a chat (a temporary fork of it); resolves the new chat's id. A harness without one is refused with the Mac's own words. */
export async function sideChat(request: Owned, chatId: string): Promise<string> {
  return str(rec(await request('chat.sideChat', { chatId }))?.chatId) ?? bad('the side chat');
}
