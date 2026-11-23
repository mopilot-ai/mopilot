// Settings › Usage: per agent its accounts with status, a bar and a relative reset for each window, and the switch-at-a-limit setting. Props only; the page's reads live in useUsagePage.
import { Text, View } from 'react-native';
import Animated, { Easing, FadeIn, LinearTransition } from 'react-native-reanimated';
import { Group, GroupItem, GroupLabel } from '../../components/Grouped';
import { SheetFrame } from '../../components/SheetFrame';
import { ErrorLine } from '../../components/ui';
import { useTranslation } from '../i18n';
import { metrics, motion, Switch, text, typo, useTokens } from './settingsAdapters';
import type { Theme } from '../ds';
import { UsageMeter } from './UsageMeter';
import type { AccountView, HarnessView, Tone, WindowView } from './usageModel';

const entering = FadeIn.duration(motion.enter).easing(Easing.bezier(...motion.curve));
const layout = LinearTransition.duration(motion.enter).easing(Easing.bezier(...motion.curve));

function Window({ w }: { w: WindowView }) {
  const theme = useTokens();
  return (
    <View
      accessible
      accessibilityLabel={[w.label, w.value, w.note, w.reset].filter(Boolean).join(', ')}
      style={{ paddingHorizontal: 16, paddingVertical: 12, gap: metrics.gap }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ ...typo.body, color: theme.ink }}>{w.label}</Text>
        <Text style={{ ...typo.callout, color: w.tone === 'bad' ? theme.bad : theme.ink2 }}>
          {w.note ? `${w.value} · ${w.note}` : w.value}
        </Text>
      </View>
      {w.left !== null && <UsageMeter left={w.left} tone={w.tone} />}
      <Text style={{ ...typo.subhead, color: theme.ink2 }}>{w.reset}</Text>
    </View>
  );
}

const statusColor = (theme: Theme, tone: Tone) => (tone === 'bad' ? theme.bad : tone === 'warn' ? theme.warn : theme.ok);

function Account({ a }: { a: AccountView }) {
  const theme = useTokens();
  return (
    <Animated.View entering={entering} layout={layout}>
      <Group>
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 13,
            paddingBottom: 0,
            flexDirection: 'row',
            justifyContent: 'space-between',
          }}
        >
          <Text style={{ ...typo.bodySemibold, color: theme.ink, flexShrink: 1 }} numberOfLines={1}>
            {a.title}
          </Text>
          {!!a.status && <Text style={{ ...typo.callout, color: statusColor(theme, a.statusTone) }}>{a.status}</Text>}
        </View>
        {a.windows.map((w) => (
          <Window key={w.key} w={w} />
        ))}
        {!!a.note && (
          <View style={{ paddingHorizontal: 16, paddingBottom: 13, paddingTop: 4 }}>
            <Text style={{ ...typo.subhead, color: theme.ink2 }}>{a.note}</Text>
          </View>
        )}
      </Group>
    </Animated.View>
  );
}

export type Leave = () => void;

export function UsagePage({
  sections,
  macName,
  online,
  busy,
  error,
  switchError,
  oldMac,
  pending,
  refresh,
  toggle,
  back,
}: {
  sections: HarnessView[] | null;
  macName: string;
  online: boolean;
  busy: boolean;
  error: string | null;
  switchError: string | null;
  /** the Mac has no usage method */
  oldMac: boolean;
  pending: Record<string, boolean>;
  refresh: () => void;
  toggle: (harness: string, on: boolean) => void;
  /** leaves the page; Settings answers Android's back button with it, once */
  back: Leave;
}) {
  const theme = useTokens();
  // the page draws again when the language changes
  useTranslation();
  return (
    <SheetFrame title={text('usage.title')} onClose={back} back>
      <Text
        style={{ ...typo.footnote, color: theme.ink2, paddingHorizontal: 16, paddingBottom: 12 }}
      >{`${macName} · ${text('usage.scope')}`}</Text>
      {!online ? (
        <ErrorLine text={text('usage.offline')} />
      ) : (
        <>
          <ErrorLine text={oldMac ? text('usage.old') : (error ?? switchError)} />
          {sections?.length === 0 && (
            <Group>
              <GroupItem title={text('usage.empty')} />
            </Group>
          )}
          {sections?.map((h) => (
            <View key={h.harness}>
              <GroupLabel>{h.title}</GroupLabel>
              {h.accounts.map((a) => (
                <Account key={a.key} a={a} />
              ))}
              {h.autoSwitch !== null && (
                <Group>
                  <GroupItem
                    title={text('autoSwitch.title')}
                    detail={text('autoSwitch.detail')}
                    trailing={
                      <Switch
                        accessibilityLabel={`${text('autoSwitch.title')}, ${h.title}`}
                        value={h.autoSwitch}
                        disabled={!!pending[h.harness]}
                        onValueChange={(on) => toggle(h.harness, on)}
                      />
                    }
                  />
                </Group>
              )}
            </View>
          ))}
          <Group>
            <GroupItem title={busy ? text('usage.refreshing') : text('usage.refresh')} onPress={busy ? undefined : refresh} />
          </Group>
        </>
      )}
    </SheetFrame>
  );
}
