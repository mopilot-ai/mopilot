// The connected computer's notification settings on the phone: when it notifies, which kinds, chat titles in push, quiet hours and, where MoMo is on for the account, MoMo's quiet hours.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { PUSH_SETTINGS } from '../../../shared/remote/pushSettings.mjs';
import type { MobileRuntime } from '../contracts';
import { Button, Card, ErrorLine, Field, useStyles, Heading, ToggleRow } from '../components/ui';
import { Unavailable, explain } from '../remote/client';
import { useOwnedRequest } from '../remote/useOwnedRequest';
import {
  KINDS,
  MODES,
  isClock,
  applyPatch,
  loadMacSettings,
  revertPatch,
  saveMacSettings,
  type MacPushPatch,
  type MacPushSettings,
  type NotifyMode,
  type QuietHours,
} from './macSettings';

const MODE_WORD: Record<NotifyMode, string> = {
  unfocused: 'When away',
  always: 'Always',
  needed: 'Only when needed',
  never: 'Never',
};
export const KIND_WORD: Record<string, string> = {
  turn: 'Finished chats',
  approval: 'Approvals',
  scheduled: 'Scheduled runs',
  goal: 'Goals',
  auth: 'Sign-in needed',
  computer: 'Computer use',
};
const DEFAULT_QUIET = PUSH_SETTINGS.momoQuietHours.default;

/** A switch for quiet hours and, while they are on, their two times; the fields follow the Mac only when its hours changed, so text being typed survives another switch's save. */
function QuietRow({
  name,
  note,
  value,
  onSave,
}: {
  name: string;
  note?: string;
  value: QuietHours | null;
  onSave: (hours: QuietHours | null) => void;
}) {
  const styles = useStyles();
  const [start, setStart] = useState(value?.start ?? DEFAULT_QUIET.start);
  const [end, setEnd] = useState(value?.end ?? DEFAULT_QUIET.end);
  const [shownStart, shownEnd] = [value?.start, value?.end];
  useEffect(() => {
    setStart(shownStart ?? DEFAULT_QUIET.start);
    setEnd(shownEnd ?? DEFAULT_QUIET.end);
  }, [shownStart, shownEnd]);
  return (
    <>
      <ToggleRow
        label={name}
        value={value !== null}
        onChange={(on) => onSave(on ? { start: DEFAULT_QUIET.start, end: DEFAULT_QUIET.end } : null)}
      />
      {note && <Text style={styles.muted}>{note}</Text>}
      {value && (
        <>
          <Field placeholder={`${name.replace(' hours', '')} from (HH:MM)`} value={start} onChangeText={setStart} />
          <Field placeholder={`${name.replace(' hours', '')} until (HH:MM)`} value={end} onChangeText={setEnd} />
          <Button
            secondary
            disabled={!isClock(start) || !isClock(end) || start === end || (start === value.start && end === value.end)}
            title={`Save ${name.replace(/^Quiet/, 'quiet')}`}
            onPress={() => onSave({ start, end })}
          />
        </>
      )}
    </>
  );
}

export function MacNotificationSettings({ runtime }: { runtime: MobileRuntime }) {
  const styles = useStyles();
  const request = useOwnedRequest(runtime);
  const [settings, setSettings] = useState<MacPushSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // what this computer cannot do yet (an older MoPilot) is information, not a failure
  const [info, setInfo] = useState<string | null>(null);
  // the latest settings, so quick changes build on each other, and the saves in the order they were made
  const latest = useRef<MacPushSettings | null>(null);
  const saves = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const show = useCallback((s: MacPushSettings) => setSettings((latest.current = s)), []);
  useEffect(() => {
    let live = true;
    loadMacSettings(request).then(
      (s) => live && show(s),
      (e: unknown) => live && (e instanceof Unavailable ? setInfo(e.message) : setError(explain(e))),
    );
    return () => {
      live = false;
    };
  }, [request, show]);
  /** The switch moves at once; the Mac's own answer replaces it when no other change is out, and a refusal puts back only this change, with the reason. */
  const save = useCallback(
    (patch: MacPushPatch) => {
      // the card only draws its switches once the settings are here
      const before = latest.current as MacPushSettings;
      setError(null);
      show(applyPatch(before, patch));
      pending.current++;
      saves.current = saves.current.then(async () => {
        try {
          const answer = await saveMacSettings(request, patch, before.momo);
          if (pending.current === 1) show(answer);
        } catch (e: unknown) {
          if (latest.current) show(revertPatch(latest.current, before, patch));
          setError(explain(e));
        } finally {
          pending.current--;
        }
      });
    },
    [request, show],
  );
  if (!settings) {
    if (info) return <Text style={styles.muted}>{info}</Text>;
    return error ? <ErrorLine text={error} /> : null;
  }
  return (
    <Card>
      <Heading>Notifications from your computer</Heading>
      <Button
        secondary
        title={`Notify: ${MODE_WORD[settings.mode]}`}
        onPress={() =>
          save({
            mode: MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length],
          })
        }
      />
      {settings.mode !== 'never' &&
        KINDS.map((kind) => (
          <ToggleRow key={kind} label={KIND_WORD[kind]} value={settings.kinds[kind]} onChange={(on) => save({ kinds: { [kind]: on } })} />
        ))}
      <ToggleRow label="Chat titles in notifications" value={settings.titlesInPush} onChange={(on) => save({ titlesInPush: on })} />
      <Text style={styles.muted}>Titles are sealed on your computer; only your phone can read them.</Text>
      {settings.quietHours !== undefined && (
        <QuietRow
          name="Quiet hours"
          note="While they last, nothing notifies. A chat that needs you is sent once when they end."
          value={settings.quietHours}
          onSave={(quietHours) => save({ quietHours })}
        />
      )}
      {settings.momoQuietHours !== undefined && (
        <QuietRow name="MoMo quiet hours" value={settings.momoQuietHours} onSave={(momoQuietHours) => save({ momoQuietHours })} />
      )}
      <ErrorLine text={error} />
    </Card>
  );
}
