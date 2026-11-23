// Settings › Computers › one Mac: its state, and while it is offline the connection checks (where the path stops) with a report to share; Connect and Remove.
import { useState } from 'react';
import { Share, Text, View } from 'react-native';
import type { MobileSnapshot } from '../contracts';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import { Icon } from '../components/Icon';
import { SheetFrame } from '../components/SheetFrame';
import { ErrorLine } from '../components/ui';
import { explain } from '../remote/client';
import { checkReport, checkSteps, STATE_WORD, stepMark, type StepState } from '../diagnostics';
import { macLink, type MacState } from '../macLink';
import type { PushUi } from '../push/controller';
import type { Machine } from '../remote/machines';
import { AgentsGroup } from './SettingsMachine';
import { useTheme } from '../theme';
import { useHardwareBack } from '../useHardwareBack';
import { typo } from '../typography';

/** A computer's laptop with its state dot at the lower right, as the header glyph draws it: ink and green while connected, gray otherwise. */
export function MacGlyph({ state }: { state: MacState }) {
  const theme = useTheme();
  return (
    <View>
      <Icon name="laptopcomputer" glyph="▭" size={18} color={state === 'connected' ? theme.ink : theme.ink3} />
      <View style={{ position: 'absolute', right: -3, bottom: -2 }}>
        <MacDot state={state} />
      </View>
    </View>
  );
}

/** The state dot beside a computer: green while connected, gray otherwise. */
export function MacDot({ state }: { state: MacState }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ width: 8, aspectRatio: 1, borderRadius: 4, backgroundColor: state === 'connected' ? theme.ok : theme.ink3 }}
    />
  );
}

export function SettingsComputer({
  state,
  pairId,
  pushUi,
  local,
  version,
  busy,
  error,
  back,
  connect,
  remove,
  share = (message) => Share.share({ message }),
  now = Date.now,
}: {
  state: MobileSnapshot;
  pairId: string;
  pushUi: PushUi | null;
  /** This Mac as the Mac lists itself among its machines (its agents), while it is the connected one. */
  local?: Machine;
  version?: string;
  busy: boolean;
  error: string | null;
  back: () => void;
  connect: () => void;
  remove: () => void;
  share?: (message: string) => Promise<unknown>;
  now?: () => number;
}) {
  useHardwareBack(back);
  const theme = useTheme();
  const [confirming, setConfirming] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);
  const link = macLink(state, pairId);
  const steps = link.online ? [] : checkSteps(state, pushUi, now());
  const tint: Record<StepState, string> = { ok: theme.ok, bad: theme.bad, wait: theme.ink2, na: theme.ink3 };
  return (
    <SheetFrame title={link.name} onClose={back} back>
      {/* a connection that failed reads as the reason a person can act on ("offline or asleep"), as the home banner once said */}
      <ErrorLine text={error === null ? null : explain(error)} />
      <Group>
        <GroupItem
          title="Status"
          detail={
            link.state === 'offline'
              ? 'To reach it while you are away, turn on Keep this Mac reachable in Settings › Connections on your Mac.'
              : undefined
          }
          trailing={<StatusValue state={link.state} word={link.word} />}
        />
      </Group>
      {local && <AgentsGroup machine={local} />}
      {steps.length > 0 && (
        <>
          <GroupLabel>Connection check</GroupLabel>
          <Group>
            {steps.map((step) => (
              <GroupItem
                key={step.name}
                title={step.name}
                detail={step.note}
                icon={
                  <Text accessibilityLabel={STATE_WORD[step.state]} style={{ ...typo.body, color: tint[step.state] }}>
                    {stepMark(step.state)}
                  </Text>
                }
              />
            ))}
            <GroupItem
              key="share"
              title="Share report"
              tone="link"
              detail={shareFailed ? 'The report could not be shared.' : 'Only these steps: no codes, keys, names or chat text.'}
              onPress={() => {
                setShareFailed(false);
                share(checkReport(steps, version)).then(
                  () => undefined,
                  () => setShareFailed(true),
                );
              }}
            />
          </Group>
        </>
      )}
      <Group>
        <GroupItem
          key="connect"
          title={busy ? 'Connecting…' : link.online ? 'Reconnect' : 'Connect'}
          tone="link"
          onPress={busy ? undefined : connect}
        />
      </Group>
      {confirming ? (
        <>
          <Text style={{ ...typo.subhead, color: theme.ink2, paddingHorizontal: 16, paddingBottom: 8 }}>
            {`Removing ${link.name} deletes its keys here, and you pair again to use it.`}
          </Text>
          <Group>
            <GroupItem
              key="remove"
              title="Remove"
              tone="danger"
              onPress={
                busy
                  ? undefined
                  : () => {
                      setConfirming(false);
                      remove();
                    }
              }
            />
            <GroupItem key="keep" title="Keep" onPress={() => setConfirming(false)} />
          </Group>
        </>
      ) : (
        <Group>
          <GroupItem key="ask" title="Remove computer" tone="danger" onPress={busy ? undefined : () => setConfirming(true)} />
        </Group>
      )}
    </SheetFrame>
  );
}

/** A computer's state at the end of its row: the dot and Connected / Available / Offline. */
export function StatusValue({ state, word }: { state: MacState; word: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <MacDot state={state} />
      <Text style={{ ...typo.callout, color: theme.ink2 }}>{word}</Text>
    </View>
  );
}
