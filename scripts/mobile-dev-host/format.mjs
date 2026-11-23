// The host's log lines: one readable line per request, reply and event, with long values cut so a terminal stays scannable.
import { prefixUnits } from '../../shared/textPrefix.mjs';

const MAX = 110;
const short = (/** @type {string} */ pair) => pair.replace(/^p_/, '').slice(0, 6);

/** A value on one line, cut to fit. */
export function brief(/** @type {unknown} */ value, max = MAX) {
  const text = JSON.stringify(value, (_k, v) => (typeof v === 'string' && v.length > 60 ? `${prefixUnits(v, 57)}…` : v)) ?? 'null';
  return text.length > max ? `${prefixUnits(text, max - 1)}…` : text;
}

const time = (/** @type {number} */ at) => new Date(at).toISOString().slice(11, 23);

/** @param {number} at @param {string} text */
export const line = (at, text) => `${time(at)} ${text}`;

/**
 * What a request's line shows first: a new chat's harness, the login it picked (an id, never a secret) and where its model access comes from lead,
 * so the cut that keeps the line short never takes them off. Object keys keep the order they were first set in.
 * @param {string} method @param {any} params
 */
const leading = (method, params) =>
  method === 'chat.start' && params
    ? {
        harness: params.harness,
        ...(params.account ? { account: params.account } : {}),
        ...(params.credential ? { credential: params.credential } : {}),
        ...params,
      }
    : params;

/** A phone's request; the relay credential an enrollment carries is never written. */
export const requestLine = (/** @type {string} */ pair, /** @type {string} */ method, /** @type {any} */ params) =>
  `phone ${short(pair)} → ${method} ${brief(method === 'machines.enroll' && params?.relay ? { ...params, relay: { ...params.relay, secret: '…' } } : (leading(method, params) ?? {}))}`;

/**
 * An enrollment as the Host in the machine can use it: the phone names the relay as it reaches it (a LAN address), which the Mac's courier refuses for plain ws and the machine could not reach;
 * `relayUrl` is the address the Host has instead. Any other request, and an enrollment with no replacement, is as it came.
 * @param {string} method @param {any} params @param {string | undefined} relayUrl
 */
export const hostSeesRelay = (method, params, relayUrl) =>
  method === 'machines.enroll' && relayUrl && params?.relay ? { ...params, relay: { ...params.relay, relayUrl } } : params;

/** The Mac's answer to it. */
export function replyLine(
  /** @type {string} */ pair,
  /** @type {string} */ method,
  /** @type {number} */ ms,
  /** @type {{ ok: boolean, value?: unknown, error?: { code: string, message: string } }} */ outcome,
) {
  const head = `phone ${short(pair)} ← ${method} ${ms}ms`;
  return outcome.ok ? `${head} ok ${brief(outcome.value ?? {}, 80)}` : `${head} ERROR ${outcome.error?.code}: ${outcome.error?.message}`;
}

/** An event pushed to a phone: what happened, in which chat, at which revision. */
export function eventLine(/** @type {string} */ pair, /** @type {any} */ event) {
  const { id: _id, t: _t, kind: _kind, ev, chatId, rev, ...rest } = event;
  const where = [chatId && `chat=${chatId}`, rev !== undefined && `rev=${rev}`].filter(Boolean).join(' ');
  const detail = ev === 'pty.data' ? `${Buffer.from(String(rest.data ?? ''), 'base64').length} bytes at ${rest.at}` : brief(rest, 90);
  return `phone ${short(pair)} ← event ${ev} ${where} ${detail}`.replace(/ +/g, ' ').trim();
}

const chat = (/** @type {any} */ p) => `chat ${p?.chatId ?? '?'}`;
/** What each request means, in a sentence for the person holding the phone. */
const REQUESTS = /** @type {Record<string, (p: any) => string>} */ ({
  'machine.hello': () => 'the phone introduces itself and asks what this Mac can do',
  'chats.recent': (p) => `the phone loads its chat list${p?.archived ? ' (archived chats)' : ''}`,
  'chats.pin': (p) => `the phone ${p?.pinned ? 'pins' : 'unpins'} ${chat(p)}`,
  'chats.rename': (p) => `the phone renames ${chat(p)}`,
  'chat.sideChat': (p) => `the phone starts a side chat from ${chat(p)}`,
  'chats.archive': (p) => `the phone ${p?.archived ? 'archives' : 'restores'} ${chat(p)}`,
  'projects.list': () => 'the phone asks which projects a new chat can use',
  'scheduled.list': () => "the phone asks for the Mac's scheduled tasks",
  'harnesses.list': () => 'the phone asks which agents a new chat can run on',
  'options.get': (p) => `the phone asks for the model and permission menus${p?.harness ? ` for ${p.harness}` : ''}`,
  'options.set': (p) => `the phone changes a setting${p?.value ? ` to ${p.value}` : ''}`,
  'commands.list': () => 'the phone asks for the / commands',
  'dictation.engine': () => 'the phone asks which speech engine the Mac uses',
  'chat.start': (p) => `the phone starts a ${p?.harness ?? 'new'} chat: "${String(p?.text ?? '').slice(0, 40)}"`,
  'chat.follow': (p) => `the phone opens ${chat(p)}: it gets the saved history, the open cards and then every live change`,
  'chat.unfollow': (p) => `the phone leaves ${chat(p)}; no more live changes for it`,
  'chat.read': (p) => `the phone reads the saved rows of ${chat(p)}`,
  'chat.send': (p) => `the phone sends a message to ${chat(p)}: "${String(p?.text ?? '').slice(0, 40)}"`,
  'chat.stop': (p) => `the phone presses Stop in ${chat(p)}`,
  'chat.switch': (p) => `the phone moves ${chat(p)} to ${p?.harness}`,
  'card.answer': (p) => `the phone answers the card in ${chat(p)} with "${p?.key}"`,
  'card.choose': () => 'the phone picks a model',
  'card.permit': (p) => `the phone sets the permission to ${p?.value}`,
  'diff.list': (p) => `the phone lists the changed files of ${chat(p)} (${p?.scope ?? 'uncommitted'})`,
  'diff.read': (p) => `the phone opens the diff of ${p?.path} in ${chat(p)}`,
  'file.read': (p) => `the phone reads the file ${p?.path} of ${chat(p)}`,
  'pty.open': (p) => `the phone opens a terminal in ${chat(p)} (${p?.cols}x${p?.rows}); the Mac approves it first`,
  'pty.write': () => 'the phone types into the terminal',
  'pty.resize': (p) => `the phone resizes the terminal to ${p?.cols}x${p?.rows}`,
  'pty.close': () => 'the phone closes the terminal',
  'frames.subscribe': (p) => `the phone starts watching the screen of ${chat(p)}`,
  'frames.unsubscribe': (p) => `the phone stops watching the screen of ${chat(p)}`,
  'device.unpair': () => 'the phone asks to be removed from this Mac',
  'push.settings.get': () => "the phone reads the Mac's notification settings",
  'push.settings.set': () => "the phone changes the Mac's notification settings",
});
/** What an event means for the phone; empty for the ones that come in streams. */
const EVENTS = /** @type {Record<string, (e: any) => string>} */ ({
  'session.patch': (e) => `${chat(e)} changed state (${Object.keys(e.patch ?? {}).join(', ') || 'nothing shown'})`,
  'items.append': (e) => `${chat(e)} got ${e.items?.length ?? 0} new thread item(s)`,
  'items.replace': (e) => `${chat(e)} updated ${e.items?.length ?? 0} thread item(s)`,
  'items.delta': () => '',
  'turn.state': (e) => `${chat(e)} ${e.started ? 'started a turn' : 'turn state changed'}`,
  'pty.data': () => '',
  'pty.exit': () => 'the terminal ended',
  'momo.changed': (e) => `MoMo's ${e.area} changed`,
});

/** A request in a sentence. */
export const explainRequest = (/** @type {string} */ method, /** @type {unknown} */ params) =>
  Object.hasOwn(REQUESTS, method) ? REQUESTS[method](params) : `the phone calls ${method}`;

/** An event in a sentence. */
export const explainEvent = (/** @type {any} */ event) =>
  Object.hasOwn(EVENTS, event.ev) ? EVENTS[event.ev](event) : `the Mac tells the phone: ${event.ev}`;
