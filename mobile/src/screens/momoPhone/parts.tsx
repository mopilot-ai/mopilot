// Shared pieces of MoMo's phone screens: the state dot, a row of answer buttons, a card, and the failure line with its one-tap fix.
import { say } from '../../momoPhone/say';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { typo } from '../../typography';
import { serifFamily } from '../../fonts';
import { ButtonRow } from '../ButtonRow';
import { Pill } from '../MomoPill';

export { ButtonRow };
import { useBusy } from './useMomoStore';
import type { Intent } from '../../momoPhone/types';
import type { Action, Dot } from '../../momoPhone/common';

export type Act = (intent: Intent) => void;

/** A button that sends one intent and is off while that intent is in flight. */
export function ActPill({ title, intent, act, strong, off }: { title: string; intent: Intent; act: Act; strong?: boolean; off?: boolean }) {
  const busy = useBusy(intent);
  // pressed, it says so at once: the same button reads Working… until the home has answered (a title that already says so, like Waking Studio…, stays)
  return (
    <Pill
      title={busy && !title.endsWith('…') ? say('workingOnIt') : title}
      label={title}
      strong={strong}
      disabled={busy || !!off}
      onPress={() => act(intent)}
    />
  );
}

export function StateDot({ dot }: { dot: Dot }) {
  const theme = useTheme();
  const color = dot === 'green' ? theme.ok : dot === 'amber' ? theme.warn : dot === 'red' ? theme.bad : theme.ink3;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: 8, aspectRatio: 1, borderRadius: 4, backgroundColor: color }}
    />
  );
}

/** The answer buttons of a card: the strong one filled, each one a typed intent. Three, or any label that is long, stack. */
/** A key for each action that tells two of one label and intent apart without the position: the second one of a kind is `…#2`. */
export function actionKeys(actions: { label: string; intent: unknown }[]): string[] {
  const seen = new Map<string, number>();
  return actions.map((a) => {
    const base = `${a.label}:${JSON.stringify(a.intent)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

export function Actions({ actions, act }: { actions: Action[]; act: Act }) {
  if (!actions.length) return null;
  const keys = actionKeys(actions);
  return (
    <ButtonRow long={actions.length > 2 || actions.some((a) => a.label.length > 14)}>
      {actions.map((a, i) => (
        <ActPill key={keys[i]} title={a.label} strong={a.strong} intent={a.intent} act={act} />
      ))}
    </ButtonRow>
  );
}

export function Card({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'warn' }) {
  const theme = useTheme();
  return (
    <View style={{ borderRadius: 22, padding: 16, marginBottom: 12, backgroundColor: tone === 'warn' ? theme.warnSoft : theme.surface }}>
      {children}
    </View>
  );
}

export const Title = ({ children }: { children: string }) => {
  const theme = useTheme();
  return (
    <Text accessibilityRole="header" style={{ ...typo.title3, color: theme.ink }}>
      {children}
    </Text>
  );
};
export const Body = ({ children, dim = true }: { children: string; dim?: boolean }) => {
  const theme = useTheme();
  return <Text style={{ ...typo.subhead, color: dim ? theme.ink2 : theme.ink, marginTop: 4 }}>{children}</Text>;
};
export const Serif = ({ children }: { children: string }) => {
  const theme = useTheme();
  return <Text style={{ ...typo.body, fontFamily: serifFamily(), color: theme.ink }}>{children}</Text>;
};

/** The real cause of a refused action, and its fix when there is one. */
export function Failure({
  failure,
  act,
  dismiss,
}: {
  failure: { cause: string; fix: { label: string; intent: Intent } | null } | null;
  act: Act;
  dismiss: () => void;
}) {
  const theme = useTheme();
  if (!failure) return null;
  return (
    <View accessibilityLiveRegion="polite" style={{ borderRadius: 16, padding: 12, marginBottom: 12, backgroundColor: theme.badSoft }}>
      <Text style={{ ...typo.subhead, color: theme.ink }}>{failure.cause}</Text>
      <ButtonRow top={8}>
        {failure.fix && <ActPill title={failure.fix.label} strong intent={failure.fix.intent} act={act} />}
        <Pill title={say('gotIt')} disabled={false} onPress={dismiss} />
      </ButtonRow>
    </View>
  );
}

/** What shows while the home is first read: quiet bars where the rows will be, never a blank page. */
export function Skeleton() {
  const theme = useTheme();
  return (
    <View accessibilityLabel={say('loading')} accessibilityRole="progressbar" style={{ gap: 12, padding: 16 }}>
      {[0.8, 0.55, 0.7].map((w) => (
        <View key={w} style={{ minHeight: 18, width: `${w * 100}%`, borderRadius: 9, backgroundColor: theme.sunken }} />
      ))}
    </View>
  );
}
