// Claude for iOS's Code-list pieces: a session row (status glyph, 17 pt title, one 15 pt grey line), a section header, and the count capsule that folds sub-sessions.
import { useLargeText } from '../useLargeText';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import Animated from 'react-native-reanimated';
import { dur } from '../motion';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import { typo } from '../typography';

/** A session's state as Claude's list draws it: waiting (amber hand), working (spinning ring), new (a blue dot: a result nobody has opened), idle, stopped (rings). */
export type SessionState = 'waiting' | 'working' | 'new' | 'idle' | 'stopped';

const spin = { from: { transform: [{ rotate: '0deg' }] }, to: { transform: [{ rotate: '360deg' }] } };

/** The glyph at the start of a row; `small` is the 18 pt size of a nested row. */
export function StatusGlyph({ state, small = false }: { state: SessionState; small?: boolean }) {
  const theme = useTheme();
  const size = small ? 18 : 22;
  if (state === 'waiting') return <Icon name="hand.raised" glyph="✋" size={size} color={theme.amber} />;
  if (state === 'working')
    return (
      <Animated.View
        style={{ animationName: spin, animationDuration: dur.spin, animationIterationCount: 'infinite', animationTimingFunction: 'linear' }}
      >
        <Icon name="circle.dotted" glyph="◌" size={size} color={theme.ink} />
      </Animated.View>
    );
  if (state === 'new') return <Icon name="circle.fill" glyph="●" size={small ? 9 : 10} color={theme.accent} />;
  return <Icon name="circle" glyph="○" size={small ? 9 : 10} color={theme.ink2} />;
}

/** A section header in Claude's list style: 15 pt grey, sentence case, with an optional glyph before it. */
export function SectionHeader({ title, icon }: { title: string; icon?: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="header"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 18, paddingBottom: 8, paddingHorizontal: 24 }}
    >
      {icon}
      <Text style={{ ...typo.subhead, color: theme.ink2 }}>{title}</Text>
    </View>
  );
}

/** A session row. `nested` is a sub-session under its parent: inset, 16 pt title. `detail` is the grey line (it may hold a glyph). */
export function SessionRow({
  title,
  detail,
  state,
  onPress,
  nested = false,
  label,
}: {
  title: string;
  detail: ReactNode;
  state: SessionState;
  onPress: () => void;
  nested?: boolean;
  /** what a screen reader says; defaults to the title and, when it is text, the grey line (the state is only drawn as a glyph) */
  label?: string;
}) {
  const theme = useTheme();
  const large = useLargeText();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label ?? (typeof detail === 'string' && detail ? `${title}, ${detail}` : title)}
      onPress={onPress}
      feel="row"
      rowColor={theme.sunken}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 14,
        paddingVertical: nested ? 7 : 10,
        paddingLeft: nested ? 60 : 24,
        paddingRight: 24,
      }}
    >
      <View style={{ width: 22, minHeight: 24, alignItems: 'center', justifyContent: 'center' }}>
        <StatusGlyph state={state} small={nested} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={large ? 2 : 1} style={{ ...(nested ? typo.callout : typo.body), color: theme.ink }}>
          {title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {typeof detail === 'string' ? (
            <Text numberOfLines={1} style={{ ...typo.subhead, color: theme.ink2, flexShrink: 1 }}>
              {detail}
            </Text>
          ) : (
            detail
          )}
        </View>
      </View>
    </Tap>
  );
}

/** The count capsule beside a parent row: the number of sub-sessions and a chevron that turns over when they are shown. */
export function FoldCapsule({
  count,
  open,
  onPress,
  state,
  disabled = false,
}: {
  count: number;
  open: boolean;
  onPress: () => void;
  /** the family's most urgent state in words ("Failed"), read out after the count */
  state?: string | null;
  /** while a search shows every family whole, so a tap cannot change a fold the user does not see */
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={[`${count} ${count === 1 ? 'sub-session' : 'sub-sessions'}`, state].filter(Boolean).join(', ')}
      accessibilityState={{ expanded: open, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        minHeight: 30,
        marginTop: 12,
        marginRight: 20,
        paddingLeft: 11,
        paddingRight: 8,
        borderRadius: 15,
        backgroundColor: theme.sunken,
      }}
    >
      <Text style={{ ...typo.subhead, color: theme.ink2 }}>{count}</Text>
      <Animated.View
        style={{ transform: [{ rotate: open ? '180deg' : '0deg' }], transitionProperty: 'transform', transitionDuration: dur.snap }}
      >
        <Icon name="chevron.down" glyph="⌄" size={12} color={theme.ink2} />
      </Animated.View>
    </Tap>
  );
}

/** The thin guide line down the left of a parent's shown sub-sessions. */
export function NestedGuide({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={{ position: 'absolute', left: 35, top: 0, bottom: 14, width: 1.5, borderRadius: 1, backgroundColor: theme.line }}
      />
      {children}
    </View>
  );
}
