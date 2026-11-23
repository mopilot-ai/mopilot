// Notification settings on the phone: alerts, Live Activity, chat titles, the open-chat policy and a test everywhere; sound, detail and quiet hours where the OS lets an app apply them (Android channels).
import { useEffect, useState } from 'react';
import { Platform, Text } from 'react-native';
import { OpenSettings } from '../components/OpenSettings';
import { Button, Card, ErrorLine, Field, useStyles, Heading, ToggleRow } from '../components/ui';
import type { PushController } from './controller';
import type { LiveActivityController } from './liveActivityController';
import { useLiveActivityUi } from './useLiveActivityUi';
import { LOCK_SCREENS } from './channels';
import { LIVE_ACTIVITY_AVAILABLE } from './liveActivity';
import { PUSH_TITLES } from './kinds';
import { isClock, type PushPrefs } from './prefs';
import type { TokenStatus } from './registration';

const TOKEN_LINE: Record<TokenStatus, string> = {
  registered: 'Registered',
  waiting: 'Waiting for a device token',
  unavailable: 'Not available in this build',
};
const LOCK_WORD = {
  show: 'Show',
  private: 'Hide details',
  hide: 'Hide',
} as const;

const TEST_LINE = {
  sent: 'Sent. This is how a notification looks on this phone.',
  failed: "Could not show a notification. Check that notifications are on for MoPilot in your phone's settings.",
} as const;

const BLOCKED_LINE = "Live Activities are off for MoPilot in your phone's settings.";
const FAILED_LINE = 'Could not update the Live Activity. It will try again.';

/** The Live Activity switch: it turns the activity itself on and off, and says when iOS or a failure keeps it from running. */
function LiveActivityRows({ activity }: { activity: LiveActivityController }) {
  const styles = useStyles();
  const ui = useLiveActivityUi(activity);
  return (
    <>
      <ToggleRow label="Live Activity" value={ui.prefs.enabled} onChange={(on) => void activity.setEnabled(on)} />
      <Text style={styles.muted}>Shows how many chats need you. Chat titles stay hidden unless you turn them on below.</Text>
      {ui.status === 'blocked' && (
        <>
          <Text style={styles.muted}>{BLOCKED_LINE}</Text>
          <OpenSettings />
        </>
      )}
      {ui.failed && <Text style={styles.muted}>{FAILED_LINE}</Text>}
    </>
  );
}

export function NotificationSettings({
  push,
  prefs,
  token,
  error = null,
  liveActivityAvailable = LIVE_ACTIVITY_AVAILABLE,
}: {
  push: PushController;
  prefs: PushPrefs;
  token: TokenStatus | null;
  /** Why the last switch was put back. */
  error?: string | null;
  /** Whether this build can start a Live Activity; the switch is not drawn without it. */
  liveActivityAvailable?: boolean;
}) {
  const styles = useStyles();
  const [test, setTest] = useState<keyof typeof TEST_LINE | null>(null);
  const [from, setFrom] = useState(prefs.quiet.from);
  const [to, setTo] = useState(prefs.quiet.to);
  useEffect(() => setFrom(prefs.quiet.from), [prefs.quiet.from]);
  useEffect(() => setTo(prefs.quiet.to), [prefs.quiet.to]);
  const android = Platform.OS === 'android';
  return (
    <Card>
      <Heading>On this phone</Heading>
      <ErrorLine text={error} />
      <ToggleRow label="Alerts" value={prefs.enabled} onChange={(on) => void push.setPrefs({ enabled: on })} />
      {prefs.enabled && token && <Text style={styles.muted}>{TOKEN_LINE[token]}</Text>}
      {liveActivityAvailable && push.liveActivity && <LiveActivityRows activity={push.liveActivity} />}
      {liveActivityAvailable && !push.liveActivity && (
        <>
          <ToggleRow label="Live Activity" value={prefs.liveActivity} onChange={(on) => void push.setPrefs({ liveActivity: on })} />
          <Text style={styles.muted}>Shows how many chats need you. Chat titles stay hidden unless you turn them on below.</Text>
        </>
      )}
      <ToggleRow label="Chat titles on the lock screen" value={prefs.titles} onChange={(on) => void push.setPrefs({ titles: on })} />
      <Text style={styles.muted}>
        Titles are sealed on your computer and only this phone can read them. They also need Chat titles in notifications on your computer.
      </Text>
      <ToggleRow
        label="Skip alerts for the chat I have open"
        value={prefs.skipOpenChat}
        onChange={(on) => void push.setPrefs({ skipOpenChat: on })}
      />
      {android && prefs.enabled && (
        <>
          <ToggleRow label="Sound" value={prefs.sound} onChange={(on) => void push.setPrefs({ sound: on })} />
          <Button
            secondary
            title={`Lock screen detail: ${LOCK_WORD[prefs.lockScreen]}`}
            onPress={() =>
              void push.setPrefs({
                lockScreen: LOCK_SCREENS[(LOCK_SCREENS.indexOf(prefs.lockScreen) + 1) % LOCK_SCREENS.length],
              })
            }
          />
          <ToggleRow label="Quiet hours" value={prefs.quiet.on} onChange={(on) => void push.setPrefs({ quiet: { on } })} />
          {prefs.quiet.on && (
            <>
              <Text style={styles.muted}>Silent from</Text>
              <Field
                placeholder="From (HH:MM)"
                value={from}
                onChangeText={(text) => {
                  setFrom(text);
                  if (isClock(text)) void push.setPrefs({ quiet: { from: text } });
                }}
              />
              <Field
                placeholder="To (HH:MM)"
                value={to}
                onChangeText={(text) => {
                  setTo(text);
                  if (isClock(text)) void push.setPrefs({ quiet: { to: text } });
                }}
              />
            </>
          )}
        </>
      )}
      {!android && <Text style={styles.muted}>Use Focus on your iPhone to silence notifications at set times.</Text>}
      <Button
        secondary
        disabled={!prefs.enabled}
        title="Send a test notification"
        onPress={() => {
          setTest(null);
          void push.sendTest().then((ok) => setTest(ok ? 'sent' : 'failed'));
        }}
      />
      {test && <Text style={styles.muted}>{TEST_LINE[test]}</Text>}
      <Text style={styles.muted}>
        Notifications say only "{PUSH_TITLES.needsYou}". Your words never leave your devices. Allow and Deny from a notification ask for
        Face ID or your passcode.
      </Text>
    </Card>
  );
}
