// The shapes of MoMo's channels and groups (A2) as the main process answers them (electron/momo/channels.cjs, channelsIpc.cjs).

/** The answer to the first row of a new channel. */
export type MomoChannelWelcome = 'yes' | 'no' | 'later';

export interface MomoChannel {
  /** opaque, made by the Mac, kept across restarts */
  id: string;
  name: string;
  /** the group it is in, or null */
  group: string | null;
  createdAt: number;
  hasInstructions: boolean;
  welcome: MomoChannelWelcome | null;
}

export interface MomoChannelGroup {
  id: string;
  name: string;
}

export type MomoChannelsReason =
  | 'not_allowed'
  | 'unavailable'
  | 'bad_args'
  | 'duplicate'
  | 'cap'
  | 'gone'
  | 'resetting'
  | 'no_harness'
  | 'failed';

/** Every answer: what was asked for, or why not (`reason`, and `error` in words for the user). */
export type MomoChannelsResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; reason: MomoChannelsReason };

/** What Everything shows (electron/momo/everything.cjs): the latest finished exchanges, newest first, each with the channel's name, and the filter's choices. */
export interface MomoEverything {
  rows: { chatId: string; turnId: string; channelId: string | null; name: string; at: number; user: string; assistant: string }[];
  /** 'main' and each open channel */
  filters: { id: string; name: string }[];
  /** the index of MoMo's chats could not be read now */
  unavailable: boolean;
}
