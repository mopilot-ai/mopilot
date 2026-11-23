// Params of MoMo's channel methods (momo.channels.*, A2; phone only, and only for an account MoMo is allowed for), and the optional `channelId` the chat methods take: a channel's opaque id as the Mac made it, checked here for its shape and by main against the list (an unknown or archived one is refused there). A name is only trimmed and bounded here; the registry checks it again (electron/momo/channels.cjs).
import { CHANNEL_ID } from '../momoChat.mjs';

const GROUP_ID = /^gr_[0-9a-f]{16}$/;
const NAME = 'Give it a name of 1 to 40 characters.';
const GONE = 'That channel isn’t there any more.';
const GROUP_GONE = 'That group isn’t there any more.';

/**
 * @param {{ bad: (message: string) => Error }} h
 * @returns {{ parsers: Record<string, (p: any) => any>, channelOf: (p: any) => { channelId?: string } }}
 */
export function momoChannelParsers({ bad }) {
  const channelId = (/** @type {unknown} */ v) => {
    if (typeof v !== 'string' || !CHANNEL_ID.test(v)) throw bad(GONE);
    return v;
  };
  const groupId = (/** @type {unknown} */ v) => {
    if (typeof v !== 'string' || !GROUP_ID.test(v)) throw bad(GROUP_GONE);
    return v;
  };
  const name = (/** @type {unknown} */ v) => {
    const t = typeof v === 'string' ? v.trim() : '';
    if (!t || t.length > 120) throw bad(NAME);
    return t;
  };
  /** A group a channel is put in: an id, or null for none (never left out: a move says where to). */
  const group = (/** @type {unknown} */ v) => (v === null ? null : groupId(v));
  /** The chat methods' optional channel: left out means MoMo's main chat. */
  const channelOf = (/** @type {any} */ p) => (p.channelId === undefined ? {} : { channelId: channelId(p.channelId) });
  return {
    channelOf,
    parsers: {
      'momo.channels.list': () => ({}),
      'momo.channels.create': (p) => ({ name: name(p.name), group: p.group === undefined ? null : group(p.group) }),
      'momo.channels.rename': (p) => ({ channelId: channelId(p.channelId), name: name(p.name) }),
      'momo.channels.archive': (p) => ({ channelId: channelId(p.channelId) }),
      'momo.channels.delete': (p) => ({ channelId: channelId(p.channelId) }),
      'momo.channels.move': (p) => {
        if (p.group === undefined) throw bad(GROUP_GONE);
        return { channelId: channelId(p.channelId), group: group(p.group) };
      },
      'momo.channels.welcome': (p) => {
        if (!['yes', 'no', 'later'].includes(p.answer)) throw bad('Pick Yes, No or Not now.');
        return { channelId: channelId(p.channelId), answer: p.answer };
      },
      'momo.channels.group.create': (p) => ({ name: name(p.name) }),
      'momo.channels.group.rename': (p) => ({ groupId: groupId(p.groupId), name: name(p.name) }),
      'momo.channels.group.delete': (p) => ({ groupId: groupId(p.groupId) }),
    },
  };
}
