// What MoMo's phone page does with channels (A2), apart from the page itself: the list the Mac keeps (read only while it lists the method; its own `enabled` says whether the flag is on), the channel shown now and the way back to Main when it goes away at the Mac, the picker sheet, the first row of an empty channel, and the "Channels" entry of the page's menu. Momo.tsx owns the picked id and the list's version, because the chat it follows and sends to depends on them.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import type { MobileRuntime } from '../contracts';
import type { MenuItem } from '../components/Menu';
import { createChannelsApi } from '../momo/channelsApi';
import { CHANNELS_LIST, type Channel, type ChannelList } from '../momo/channelsContract';
import { useLoad, type Guard } from '../momo/useLoad';
import { useTranslation } from '../ui/i18n';
import { ChannelSheet, ChannelWelcome } from './MomoChannels';

export function useChannelsPage({
  runtime,
  online,
  guard,
  has,
  methods,
  channelId,
  setChannelId,
  version,
  bump,
  chat,
}: {
  runtime: MobileRuntime;
  online: boolean;
  guard: Guard;
  has: (method: string) => boolean;
  /** the Mac's listed methods, which the list is read again after */
  methods: unknown;
  channelId: string | null;
  setChannelId: (id: string | null) => void;
  /** bumped as the Mac says the list changed */
  version: number;
  bump: () => void;
  /** the page goes to its chat tab */
  chat: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const api = useMemo(() => createChannelsApi(runtime), [runtime]);
  const list = useLoad<ChannelList | null>(runtime, () => (online && has(CHANNELS_LIST) ? guard(api.list) : Promise.resolve(null)), [
    api,
    online,
    guard,
    methods,
    version,
  ]);
  const listed = list.data;
  const on = listed?.enabled === true;
  const channel: Channel | null = listed?.enabled ? (listed.channels.find((c) => c.id === channelId) ?? null) : null;
  // a channel that is gone (archived or deleted anywhere) or channels turned off: back to Main once the page has seen it in the list (one just made is not there yet)
  const seen = useRef(false);
  useEffect(() => {
    if (channel) seen.current = true;
    else if (channelId && listed && seen.current) {
      seen.current = false;
      setChannelId(null);
    }
  }, [channel, channelId, listed, setChannelId]);
  const menu: MenuItem[] = on ? [{ label: t('momoChannels.title'), onPress: () => setOpen(true) }] : [];
  const sheet: ReactNode = listed?.enabled ? (
    <ChannelSheet
      open={open}
      onClose={() => setOpen(false)}
      api={api}
      list={listed}
      current={channelId}
      pick={(id) => {
        seen.current = false;
        setChannelId(id);
        chat();
      }}
      changed={bump}
      gone={() => setChannelId(null)}
    />
  ) : null;
  /** MoMo's first row in an empty channel; `send` puts a normal message in the channel's chat. */
  const welcome = (send: (text: string) => void): ReactNode =>
    channel ? (
      <View style={{ paddingHorizontal: 18 }}>
        <ChannelWelcome api={api} channel={channel} send={send} changed={bump} />
      </View>
    ) : null;
  return { channel, menu, sheet, welcome };
}
