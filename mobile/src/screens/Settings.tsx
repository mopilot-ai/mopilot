// Settings as Claude's sheet: the account, the paired Macs with their state (Add a computer opens pairing), the app's rows, and Sign out.
import { useEffect, useState } from 'react';
import { Linking, Switch } from 'react-native';
import { COMMUNITY_URL } from '../../../shared/community.mjs';
import type { MobileRuntime, MobileSnapshot } from '../contracts';
import type { ChatListItem } from '../components/ChatRow';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import { SheetFrame } from '../components/SheetFrame';
import { Icon } from '../components/Icon';
import { ErrorLine } from '../components/ui';
import { useHardwareBack } from '../useHardwareBack';
import { APPEARANCE_WORD, type AppearanceControl } from '../appearance';
import type { HapticsControl } from '../haptics';
import type { PhoneUiControl } from '../ui/flag';
import { macState, macWord, useMachines } from '../macLink';
import { LIVE_ACTIVITY_AVAILABLE } from '../push/liveActivity';
import type { PushController, PushUi } from '../push/controller';
import { useTheme } from '../theme';
import { MacGlyph, SettingsComputer } from './SettingsComputer';
import { SettingsNewChat } from './SettingsNewChat';
import { MachineGlyph, SettingsMachine } from './SettingsMachine';
import { SettingsUsage } from './SettingsUsage';
import {
  AboutPage,
  AccountPage,
  accountTitle,
  AppearancePage,
  Avatar,
  NotificationsPage,
  PrivacyPage,
  useAppearance,
} from './SettingsPages';

export type Page =
  | 'usage'
  | 'main'
  | 'account'
  | 'notifications'
  | 'appearance'
  | 'privacy'
  | 'about'
  | `computer:${string}`
  | `machine:${string}`
  | `newchat:${string}`;

const summary = (pushUi: PushUi, liveActivity: boolean) =>
  pushUi.step !== 'granted'
    ? 'Off'
    : (pushUi.prefs.enabled ? 'On' : 'Off') + (liveActivity ? ` · Live Activity ${pushUi.prefs.liveActivity ? 'on' : 'off'}` : '');

/** The Haptic feedback switch: the saved choice once read; a refused save puts the old one back. */
function HapticsSwitch({ haptics }: { haptics: HapticsControl }) {
  const theme = useTheme();
  const [on, setOn] = useState(true);
  useEffect(() => {
    let live = true;
    void haptics.read().then((value) => live && setOn(value));
    return () => {
      live = false;
    };
  }, [haptics]);
  return (
    <Switch
      accessibilityLabel="Haptic feedback"
      value={on}
      trackColor={{ true: theme.ok, false: theme.sunken }}
      onValueChange={(next) => {
        setOn(next);
        haptics.set(next).catch(() => setOn(!next));
      }}
    />
  );
}

/** Stands in for a build without the Appearance control, whose row is not drawn. */
export const NO_APPEARANCE: AppearanceControl = { read: async () => 'system', set: async () => undefined };

export function Settings({
  runtime,
  state,
  push,
  pushUi,
  appearance,
  haptics,
  phoneUi,
  liveActivityAvailable = LIVE_ACTIVITY_AVAILABLE,
  busy,
  error,
  version,
  devEndpoints,
  home,
  pair,
  connect,
  remove,
  signOut,
  deleteAccount,
  uninvited = false,
  start,
  machineChats,
}: {
  runtime: MobileRuntime;
  state: MobileSnapshot;
  push?: PushController;
  pushUi: PushUi;
  appearance?: AppearanceControl;
  haptics?: HapticsControl;
  phoneUi?: PhoneUiControl;
  /** Whether this build has the Live Activity: its switch and its summary are drawn only then. */
  liveActivityAvailable?: boolean;
  busy: boolean;
  error: string | null;
  version?: string;
  devEndpoints?: { relayUrl: string; accountOrigin: string };
  /** Closes the sheet: its ✕ and the hardware back button. */
  home: () => void;
  pair: () => void;
  connect: (pairId: string) => void;
  remove: (pairId: string) => void;
  signOut: () => void;
  deleteAccount: (confirm: string) => Promise<void>;
  /** The account service says this account has no Mobile Remote. */
  uninvited?: boolean;
  /** The page to open on: a Host's own page from its card on the home; the list otherwise. */
  start?: Page;
  /** The Mac's chat list and how a chat opens, for a machine page's Chats. */
  machineChats?: { list: ChatListItem[] | null; open: (chatId: string) => void };
}) {
  const theme = useTheme();
  const [page, setPage] = useState<Page>(start ?? 'main');
  const [signingOut, setSigningOut] = useState(false);
  const machines = useMachines();
  const [mode, choose] = useAppearance(appearance ?? NO_APPEARANCE);
  const main = () => setPage('main');
  // the list closes the sheet; each page answers the hardware back itself, returning to the list
  useHardwareBack(home, page === 'main');
  const glyph = (name: Parameters<typeof Icon>[0]['name'], fallback: string, color = theme.ink) => (
    <Icon name={name} glyph={fallback} size={18} color={color} />
  );
  if (page === 'usage')
    return <SettingsUsage key={JSON.stringify([state.selectedPair, state.generation])} runtime={runtime} state={state} back={main} />;
  if (page === 'account') return <AccountPage state={state} busy={busy} back={main} deleteAccount={deleteAccount} signOut={signOut} />;
  if (page === 'notifications' && push)
    return (
      <NotificationsPage
        runtime={runtime}
        state={state}
        push={push}
        pushUi={pushUi}
        liveActivityAvailable={liveActivityAvailable}
        back={main}
      />
    );
  if (page === 'appearance') return <AppearancePage mode={mode} choose={choose} back={main} />;
  if (page === 'privacy') return <PrivacyPage back={main} />;
  if (page === 'about')
    return (
      <AboutPage
        version={version}
        devEndpoints={devEndpoints}
        phoneUi={phoneUi}
        machineChats={runtime.direct ? { on: runtime.direct.chat.enabled(), why: runtime.direct.chat.why() } : undefined}
        back={main}
      />
    );
  // the Mac's Hosts, in the Mac's own words; none while it is away or has no Host access
  const hosts = machines?.filter((item) => item.id !== 'local') ?? [];
  const host = hosts.find((item) => `machine:${item.id}` === page);
  const newChatHost = hosts.find((item) => `newchat:${item.id}` === page);
  if (newChatHost && machineChats)
    return (
      <SettingsNewChat
        machine={newChatHost}
        runtime={runtime}
        back={() => setPage(`machine:${newChatHost.id}`)}
        opened={machineChats.open}
      />
    );
  if (host)
    return (
      <SettingsMachine
        machine={host}
        // a page opened from a card or a row on the home goes back to the home, not to a list the person never opened
        back={start ? home : main}
        runtime={runtime}
        chats={machineChats}
        newChat={() => setPage(`newchat:${host.id}`)}
      />
    );
  const computer = state.pairs.find((item) => `computer:${item.pairId}` === page);
  if (computer)
    return (
      <SettingsComputer
        state={state}
        pairId={computer.pairId}
        pushUi={push ? pushUi : null}
        local={state.selectedPair === computer.pairId ? machines?.find((item) => item.id === 'local') : undefined}
        version={version}
        busy={busy}
        error={error}
        back={main}
        connect={() => connect(computer.pairId)}
        remove={() => {
          main();
          remove(computer.pairId);
        }}
      />
    );
  const user = state.user;
  return (
    <SheetFrame title="Settings" onClose={home}>
      <ErrorLine text={error} />
      <Group>
        <GroupItem
          title={accountTitle(user)}
          detail="MoPilot account"
          icon={<Avatar user={user} size={32} />}
          end="chevron"
          onPress={() => setPage('account')}
        />
      </Group>
      <GroupLabel>Computers</GroupLabel>
      <Group>
        {state.pairs.map((item) => {
          const mac = macState(state, item.pairId);
          return (
            <GroupItem
              key={item.pairId}
              title={item.name?.trim() || 'Computer'}
              // the laptop turns gray and its dot goes from green to gray while the Mac is away; nothing else on the row changes
              icon={<MacGlyph state={mac} />}
              // the Mac has stopped serving this account, which reads as nothing but offline otherwise
              value={uninvited && mac === 'offline' ? 'Not available for this account' : macWord(state, item.pairId)}
              end="chevron"
              onPress={() => setPage(`computer:${item.pairId}`)}
            />
          );
        })}
        {hosts.map((item) => (
          <GroupItem
            key={`machine:${item.id}`}
            title={item.name}
            icon={<MachineGlyph tone={item.tone} />}
            value={item.line}
            end="chevron"
            onPress={() => setPage(`machine:${item.id}`)}
          />
        ))}
        <GroupItem key="add" title="Add a computer" tone="link" icon={glyph('plus', '+', theme.accent)} onPress={pair} />
      </Group>
      <Group>
        <GroupItem title="Usage" detail="Limits and accounts" end="chevron" onPress={() => setPage('usage')} />
      </Group>
      <GroupLabel>App</GroupLabel>
      <Group>
        {push && (
          <GroupItem
            key="notifications"
            title="Notifications"
            icon={glyph('bell', '♪')}
            value={summary(pushUi, liveActivityAvailable)}
            end="chevron"
            onPress={() => setPage('notifications')}
          />
        )}
        {appearance && (
          <GroupItem
            key="appearance"
            title="Appearance"
            icon={glyph('sun.max', '☼')}
            value={APPEARANCE_WORD[mode]}
            end="chevron"
            onPress={() => setPage('appearance')}
          />
        )}
        {haptics && (
          <GroupItem
            key="haptics"
            title="Haptic feedback"
            icon={glyph('iphone.radiowaves.left.and.right', '≋')}
            trailing={<HapticsSwitch haptics={haptics} />}
          />
        )}
        <GroupItem key="privacy" title="Privacy" icon={glyph('lock', '⚿')} end="chevron" onPress={() => setPage('privacy')} />
        <GroupItem key="about" title="About" icon={glyph('info.circle', 'ⓘ')} end="chevron" onPress={() => setPage('about')} />
        {/* the community's one link, opened in the system browser; the site redirects it to the current invite, so no invite is in the app */}
        <GroupItem
          key="community"
          title="Join the community"
          detail="Questions, feedback and other users, on Discord."
          icon={glyph('bubble.left.and.bubble.right', '☺')}
          end="chevron"
          onPress={() => void Linking.openURL(COMMUNITY_URL).catch(() => undefined)}
        />
      </Group>
      {/* asked once more, as removing a computer is: signing out clears this phone's pairs, so the next use signs in and pairs again */}
      {signingOut ? (
        <Group>
          <GroupItem key="confirm" title="Confirm sign out" tone="danger" onPress={busy ? undefined : signOut} />
          <GroupItem key="cancel" title="Cancel" onPress={() => setSigningOut(false)} />
        </Group>
      ) : (
        <Group>
          <GroupItem key="ask" title="Sign out" tone="danger" onPress={busy ? undefined : () => setSigningOut(true)} />
        </Group>
      )}
    </SheetFrame>
  );
}
