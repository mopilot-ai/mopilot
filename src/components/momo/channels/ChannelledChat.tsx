// MoMo's chat inside the shell with channels (A2): with `momo.channels` off it is the shell around the chat, as M0b drew it; on, the rail lists Main, Everything, groups and channels with New channel and New group, a channel's page has its header, its first row and its own composer line ("Message #name"), and Everything is the feed of every channel's rows with its filter. Main stays the page MoMo opens on.
import type { ReactNode } from 'react';
import { navigate } from '../../../store/panes';
import type { MomoTab } from '../MomoNav';
import { MomoChatTab } from '../MomoChatTab';
import { MomoShell } from '../shell/MomoShell';
import { ChannelHeader, WelcomeRow } from './ChannelChrome';
import { CHANNEL_COPY as C } from './channelCopy';
import { EverythingFeed } from './EverythingFeed';
import { EVERYTHING, useChannelsUi } from './useChannelsUi';

function Plain({ chatId }: { chatId?: string }) {
  return (
    <MomoShell chatId={chatId}>
      <MomoChatTab key={chatId ?? 'main'} chatId={chatId} shell />
    </MomoShell>
  );
}

function WithChannels({ chatId }: { chatId?: string }) {
  const ui = useChannelsUi();
  if (!ui.enabled) return <Plain chatId={chatId} />;
  const body =
    chatId === EVERYTHING ? (
      <EverythingFeed
        open={(row) => {
          // a row opens the chat it came from (Main: the main chat's own page)
          if (row.channelId) navigate({ name: 'momo', tab: 'chat', chatId: row.chatId });
          else navigate({ name: 'momo', tab: 'chat' });
        }}
      />
    ) : (
      <MomoChatTab
        key={chatId ?? 'main'}
        chatId={chatId}
        shell
        placeholder={ui.channel ? C.placeholder(ui.channel.name) : undefined}
        extra={
          ui.channel && chatId ? (
            <>
              <ChannelHeader channel={ui.channel} groups={ui.groups} act={ui.actions} />
              <WelcomeRow channel={ui.channel} chatId={chatId} />
            </>
          ) : null
        }
      />
    );
  return (
    <>
      <MomoShell
        onNewChannel={ui.newChannel}
        onNewGroup={ui.newGroup}
        channels={ui.rail}
        chatId={chatId}
        channel={ui.channel?.name}
        feed={chatId === EVERYTHING}
      >
        {body}
      </MomoShell>
      {ui.dialogs}
    </>
  );
}

export function ChannelledChat({ chatId, on }: { chatId?: string; on: boolean }) {
  return on ? <WithChannels chatId={chatId} /> : <Plain chatId={chatId} />;
}

function PageWithChannels({ tab, children }: { tab: MomoTab; children: ReactNode }) {
  const ui = useChannelsUi();
  if (!ui.enabled) return <MomoShell tab={tab}>{children}</MomoShell>;
  return (
    <>
      <MomoShell tab={tab} onNewChannel={ui.newChannel} onNewGroup={ui.newGroup} channels={ui.rail}>
        {children}
      </MomoShell>
      {ui.dialogs}
    </>
  );
}

/** A page of MoMo's beside the chat (Memory, Tasks) in the shell: the same rail as the chat's, with the channels where `momo.channels` is on. */
export function ChannelledPage({ tab, on, children }: { tab: MomoTab; on: boolean; children: ReactNode }) {
  return on ? <PageWithChannels tab={tab}>{children}</PageWithChannels> : <MomoShell tab={tab}>{children}</MomoShell>;
}
