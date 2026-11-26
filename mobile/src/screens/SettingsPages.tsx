// Settings' second-level pages, each a sheet page with ‹: the account (with Delete account), Notifications, Appearance, Privacy and About.
import { useEffect, useRef, useState } from 'react';
import { savedHistoryClear } from '../remote/savedHistory';
import { Text, View } from 'react-native';
import type { MobileRuntime, MobileSnapshot } from '../contracts';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import { SheetFrame } from '../components/SheetFrame';
import { AboutPerf } from './AboutPerf';
import { AboutTrace } from './AboutTrace';
import { t } from '../ui/i18n';
import type { PhoneUiControl } from '../ui/flag';
import { PhoneUiChoice, usePhoneUiMarker } from '../ui/phoneUi/PhoneUiChoice';
import { Button, Card, ErrorLine, useStyles } from '../components/ui';
import { DeleteAccount } from '../components/DeleteAccount';
import { APPEARANCES, APPEARANCE_WORD, type Appearance, type AppearanceControl } from '../appearance';
import { NotificationsCard } from '../push/NotificationsCard';
import { NotificationSettings } from '../push/NotificationSettings';
import { MacNotificationSettings } from '../push/MacNotificationSettings';
import type { PushController, PushUi } from '../push/controller';
import { useTheme } from '../theme';
import { useHardwareBack } from '../useHardwareBack';
import { typo, typoWeight } from '../typography';

/** Two letters for the account's circle: the name's first two words, else the email's first letter. */
export function initials(user: MobileSnapshot['user']): string {
  const words = (user?.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length)
    return words
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('');
  return (user?.email ?? user?.id ?? '?').trim().charAt(0).toUpperCase() || '?';
}

/** The account's row title: its email, else its name, else its id. */
export const accountTitle = (user: MobileSnapshot['user']) => user?.email ?? user?.name ?? user?.id ?? '';

/** The account's initials in a circle, as Claude's settings row draws it. */
export function Avatar({ user, size = 40 }: { user: MobileSnapshot['user']; size?: number }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.sunken,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text allowFontScaling={false} style={{ fontSize: size * 0.36, fontWeight: typoWeight.semibold, color: theme.ink }}>
        {initials(user)}
      </Text>
    </View>
  );
}

const muted = {
  ...typo.subhead,
  paddingHorizontal: 16,
  paddingBottom: 12,
} as const;

export function AccountPage({
  state,
  busy,
  back,
  deleteAccount,
  signOut,
}: {
  state: MobileSnapshot;
  busy: boolean;
  back: () => void;
  deleteAccount: (confirm: string) => Promise<void>;
  signOut: () => void;
}) {
  useHardwareBack(back);
  // asked once more, as removing a computer is: signing out clears this phone's pairs, so the next use signs in and pairs again
  const [signingOut, setSigningOut] = useState(false);
  const user = state.user;
  return (
    <SheetFrame title="Account" onClose={back} back>
      <Group>
        <GroupItem
          title={accountTitle(user)}
          detail={user?.name && user.email ? `${user.name} · MoPilot account` : 'MoPilot account'}
          icon={<Avatar user={user} size={32} />}
        />
      </Group>
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
      <DeleteAccount email={user?.email} busy={busy} deleteAccount={deleteAccount} />
    </SheetFrame>
  );
}

export function NotificationsPage({
  runtime,
  state,
  push,
  pushUi,
  liveActivityAvailable,
  back,
}: {
  runtime: MobileRuntime;
  state: MobileSnapshot;
  push: PushController;
  pushUi: PushUi;
  liveActivityAvailable: boolean;
  back: () => void;
}) {
  useHardwareBack(back);
  const styles = useStyles();
  return (
    <SheetFrame title="Notifications" onClose={back} back>
      <ErrorLine text={pushUi.notice} />
      {pushUi.step === 'granted' ? (
        <NotificationSettings
          push={push}
          prefs={pushUi.prefs}
          token={pushUi.token}
          error={pushUi.prefsError}
          liveActivityAvailable={liveActivityAvailable}
        />
      ) : pushUi.step === 'explain' || pushUi.step === 'blocked' ? (
        <NotificationsCard push={push} step={pushUi.step} busy={pushUi.busy} />
      ) : pushUi.step === 'later' ? (
        <Card>
          <Text style={styles.muted}>Notifications are off. Turn them on to be told when a chat needs you.</Text>
          <Button title={pushUi.busy ? 'Asking…' : 'Turn on notifications'} disabled={pushUi.busy} onPress={() => void push.accept()} />
        </Card>
      ) : null}
      {/* when, which kinds and quiet hours live on the Mac, which decides when to push */}
      {state.phase === 'online' && <MacNotificationSettings key={`${state.generation}:${state.selectedPair}`} runtime={runtime} />}
    </SheetFrame>
  );
}

/** The saved choice, read once; a choice made while it is still being read wins over it. */
export function useAppearance(appearance: AppearanceControl) {
  const [mode, setMode] = useState<Appearance>('system');
  const chosen = useRef(false);
  useEffect(() => {
    let live = true;
    void appearance.read().then((value) => live && !chosen.current && setMode(value));
    return () => {
      live = false;
    };
  }, [appearance]);
  const choose = (next: Appearance) => {
    const before = mode;
    chosen.current = true;
    setMode(next);
    // a choice that could not be kept is shown as it was
    appearance.set(next).catch(() => setMode(before));
  };
  return [mode, choose] as const;
}

export function AppearancePage({ mode, choose, back }: { mode: Appearance; choose: (next: Appearance) => void; back: () => void }) {
  useHardwareBack(back);
  return (
    <SheetFrame title="Appearance" onClose={back} back>
      <Group>
        {APPEARANCES.map((value) => (
          <GroupItem key={value} title={APPEARANCE_WORD[value]} end={mode === value ? 'check' : 'none'} onPress={() => choose(value)} />
        ))}
      </Group>
    </SheetFrame>
  );
}

export function PrivacyPage({ back }: { back: () => void }) {
  useHardwareBack(back);
  const theme = useTheme();
  // only where this build keeps saved chat history: a copy of recent chats sealed on this phone, cleared here
  const clear = savedHistoryClear();
  const [cleared, setCleared] = useState(false);
  return (
    <SheetFrame title="Privacy" onClose={back} back>
      <Text style={{ ...muted, color: theme.ink2 }}>
        Your chats, approvals and files stay on your Mac. This app reaches them end-to-end encrypted through a relay that cannot read them.
      </Text>
      <Text style={{ ...muted, color: theme.ink2 }}>
        Notifications carry only a short fixed title. With Chat titles on the lock screen on, your Mac can also seal a chat title that only
        this phone can read.
      </Text>
      {clear && (
        <>
          <Text style={{ ...muted, color: theme.ink2 }}>
            This phone keeps an encrypted copy of your recent chats so they open at once. The copy can be included in a backup of this
            phone, but it cannot be read without a key that stays in this phone's Keychain and never leaves it. The ids of the chats and
            when they were saved are not encrypted. It goes when you sign out or remove a computer.
          </Text>
          <Text style={{ ...muted, color: theme.ink2 }}>Clearing removes the copy on this phone. Your chats stay on your Mac.</Text>
          <Button
            secondary
            title={cleared ? 'Saved chat history cleared' : 'Clear saved chat history'}
            disabled={cleared}
            onPress={() =>
              void clear().then(
                () => setCleared(true),
                () => undefined,
              )
            }
          />
        </>
      )}
    </SheetFrame>
  );
}

/** Where the switch for chats on machines comes from, in words. */
const WHY: Record<string, string> = { saved: 'set on this phone', build: 'this build', mac: 'your Mac' };

export function AboutPage({
  version,
  devEndpoints,
  phoneUi,
  machineChats,
  back,
}: {
  version?: string;
  /** Whether this phone follows a machine's chat itself, and why: what to read first when a machine's chats do not open. */
  machineChats?: { on: boolean; why: string };
  devEndpoints?: { relayUrl: string; accountOrigin: string };
  /** The Phone UI switch: Classic or New, applied the next launch; the version line says which one is drawn. */
  phoneUi?: PhoneUiControl;
  back: () => void;
}) {
  useHardwareBack(back);
  const marker = usePhoneUiMarker(phoneUi);
  return (
    <SheetFrame title="About" onClose={back} back>
      <Group>
        <GroupItem key="app" title="MoPilot" value={version ? `Version ${version}${marker ? ` · ${marker}` : ''}` : undefined} />
        {machineChats && (
          <GroupItem
            key="machine-chats"
            title="Chats on machines"
            value={machineChats.on ? `On · ${WHY[machineChats.why] ?? machineChats.why}` : 'Off'}
          />
        )}
        {devEndpoints && <GroupItem key="relay" title="Relay" detail={devEndpoints.relayUrl} />}
        {devEndpoints && <GroupItem key="account" title="Account" detail={devEndpoints.accountOrigin} />}
      </Group>
      {phoneUi && (
        <>
          <GroupLabel>{t('phoneUi.title')}</GroupLabel>
          <PhoneUiChoice control={phoneUi} />
        </>
      )}
      <AboutPerf />
      {devEndpoints && <GroupLabel>Development build</GroupLabel>}
      {devEndpoints && <AboutTrace />}
    </SheetFrame>
  );
}
