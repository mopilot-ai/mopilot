// window.native.momoChannels's types (MoMo's channels and groups, A2), merged into NativeApi; the calls are declared in electron/bridge/momoChannels.cjs.
import type { MomoChannel, MomoChannelGroup, MomoChannelWelcome, MomoChannelsResult, MomoEverything } from './contracts/momoChannels';

declare module '../native' {
  interface NativeApi {
    momoChannels: {
      /** the open channels and the groups; `enabled: false` (and nothing else) while `momo.channels` is off */
      list(): Promise<MomoChannelsResult<{ enabled: boolean; channels: MomoChannel[]; groups: MomoChannelGroup[]; room: number }>>;
      /** a channel's chat, made on first use (a warning when part of MoMo's brain couldn't be applied) */
      chat(channelId: string): Promise<MomoChannelsResult<{ chatId: string; warning: string | null }>>;
      /** a new channel, by name only (`group`: a group to put it in) */
      create(name: string, group?: string | null): Promise<MomoChannelsResult<{ channel: MomoChannel }>>;
      rename(channelId: string, name: string): Promise<MomoChannelsResult<{ channel: MomoChannel }>>;
      archive(channelId: string): Promise<MomoChannelsResult<{ id: string }>>;
      /** undo of an archive */
      restore(channelId: string): Promise<MomoChannelsResult<{ channel: MomoChannel }>>;
      delete(channelId: string): Promise<MomoChannelsResult<{ id: string }>>;
      move(channelId: string, group: string | null): Promise<MomoChannelsResult<{ channel: MomoChannel }>>;
      reorder(channelId: string, dir: 'up' | 'down'): Promise<MomoChannelsResult<{ channel: MomoChannel }>>;
      getInstructions(channelId: string): Promise<MomoChannelsResult<{ text: string }>>;
      setInstructions(channelId: string, text: string): Promise<MomoChannelsResult<{ channel: MomoChannel }>>;
      welcome(channelId: string, answer: MomoChannelWelcome): Promise<MomoChannelsResult<{ channel: MomoChannel }>>;
      /** Everything's rows (all, or one channel's, or 'main') */
      everything(only?: string): Promise<MomoChannelsResult<MomoEverything>>;
      createGroup(name: string): Promise<MomoChannelsResult<{ group: MomoChannelGroup }>>;
      renameGroup(groupId: string, name: string): Promise<MomoChannelsResult<{ group: MomoChannelGroup }>>;
      deleteGroup(groupId: string): Promise<MomoChannelsResult<{ removed: boolean }>>;
      /** undo of a group's delete: the group under its own id, with the channels that were in it */
      restoreGroup(group: MomoChannelGroup, channelIds: string[]): Promise<MomoChannelsResult<{ group: MomoChannelGroup }>>;
      onChanged(cb: () => void): () => void;
    };
  }
}
