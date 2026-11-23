// The requests the phone makes about MoMo's channels (momo.channels.*), each answer checked; the chat methods take the channel in `channelId` (momo/api.ts, momo/follow.ts). A refusal arrives as the Mac's own short words in the error's message.
import type { MobileRuntime } from '../contracts';
import { parseChanged, parseChannels } from './channelsContract';

export function createChannelsApi(runtime: MobileRuntime) {
  const call = (method: string, params: Record<string, unknown> = {}) => runtime.request(method, params);
  return {
    list: async () => parseChannels(await call('momo.channels.list')),
    /** A channel by name only, optionally in a group. */
    create: async (name: string, group: string | null = null) => parseChanged(await call('momo.channels.create', { name, group })),
    rename: async (channelId: string, name: string) => parseChanged(await call('momo.channels.rename', { channelId, name })),
    archive: (channelId: string) => call('momo.channels.archive', { channelId }),
    remove: (channelId: string) => call('momo.channels.delete', { channelId }),
    move: async (channelId: string, group: string | null) => parseChanged(await call('momo.channels.move', { channelId, group })),
    welcome: async (channelId: string, answer: 'yes' | 'no' | 'later') =>
      parseChanged(await call('momo.channels.welcome', { channelId, answer })),
    createGroup: (name: string) => call('momo.channels.group.create', { name }),
    renameGroup: (groupId: string, name: string) => call('momo.channels.group.rename', { groupId, name }),
    removeGroup: (groupId: string) => call('momo.channels.group.delete', { groupId }),
  };
}
