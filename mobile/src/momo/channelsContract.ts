// The shape of momo.channels.list and of the channel and group the change methods answer with (the Mac's registry, electron/momo/channels.cjs; design/phone-on-orca/momo-channels-contract.md), checked before the page draws them: a row that is not one is left out, a reply that is not a list throws, and `enabled` must be exactly true for any of it to show.
export type Channel = {
  id: string;
  name: string;
  /** the group it is in, or null */
  group: string | null;
  hasInstructions: boolean;
  welcome: 'yes' | 'no' | 'later' | null;
};
export type Group = { id: string; name: string };
export type ChannelList = { enabled: boolean; channels: Channel[]; groups: Group[]; room: number };

/** The Mac's list method: a Mac that does not list it has no channels. */
export const CHANNELS_LIST = 'momo.channels.list';
/** The id a channel is sent under in the outbox: `momo:` and the channel's id. Main is plain `momo`. */
export const channelChatKey = (channelId: string) => `momo:${channelId}`;
/** The channel an outbox chat key names, or null (MoMo's main chat). */
export const channelOfKey = (chatKey: string) => (chatKey.startsWith('momo:') ? chatKey.slice('momo:'.length) : null);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** One channel, or null when it is not one. */
export function parseChannel(value: unknown): Channel | null {
  const r = record(value);
  const id = text(r?.id);
  const name = text(r?.name);
  if (!r || !id || !name) return null;
  return {
    id,
    name,
    group: text(r.group),
    hasInstructions: r.hasInstructions === true,
    welcome: r.welcome === 'yes' || r.welcome === 'no' || r.welcome === 'later' ? r.welcome : null,
  };
}

const parseGroup = (value: unknown): Group | null => {
  const r = record(value);
  const id = text(r?.id);
  const name = text(r?.name);
  return id && name ? { id, name } : null;
};

/** `momo.channels.list`: what the Mac keeps; throws for a reply that is not a list. */
export function parseChannels(value: unknown): ChannelList {
  const v = record(value);
  if (!v || !Array.isArray(v.channels) || !Array.isArray(v.groups)) throw new Error('Could not read the channels.');
  const channels = v.channels.map(parseChannel).filter((c): c is Channel => c !== null);
  const groups = v.groups.map(parseGroup).filter((g): g is Group => g !== null);
  return { enabled: v.enabled === true, channels, groups, room: Number.isInteger(v.room) ? (v.room as number) : 0 };
}

/** The channel a change method answered with; throws when it answered none. */
export function parseChanged(value: unknown): Channel {
  const channel = parseChannel(record(value)?.channel);
  if (!channel) throw new Error('Could not read the channel.');
  return channel;
}
