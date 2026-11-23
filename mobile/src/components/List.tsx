// A grouped list as in iOS Settings: rounded groups of rows, each a name, an optional value and a chevron when it opens something.
import type { ReactElement, ReactNode } from 'react';
import { Children, Fragment } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import { typo } from '../typography';

/** Rows on one rounded surface, with a hairline between them. */
export function ListGroup({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={{ gap: 6 }}>
      <View style={{ borderRadius: 12, backgroundColor: theme.sunken, overflow: 'hidden' }}>
        {rows.map((row, i) => (
          // each row keeps its own key (Children.toArray gives every child one)
          <Fragment key={(row as ReactElement).key}>
            {i > 0 && <View style={{ marginLeft: 16, borderTopWidth: 1, borderTopColor: theme.line }} />}
            {row}
          </Fragment>
        ))}
      </View>
    </View>
  );
}

/** A row: its name, and its value or state at the end; with `onPress` it is a button with a chevron, or `action` drawn in the accent. */
export function ListRow({
  label,
  value,
  onPress,
  action = false,
  danger = false,
  disabled = false,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  /** a row that does something here (Pair a computer) rather than opening a page: no chevron, accent text */
  action?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const ink = danger ? theme.bad : action ? theme.accent : theme.ink;
  const body = (
    <>
      <Text style={{ flex: 1, ...typo.callout, color: ink }}>{label}</Text>
      {!!value && (
        <Text numberOfLines={1} style={{ flexShrink: 1, ...typo.callout, color: theme.ink3 }}>
          {value}
        </Text>
      )}
      {onPress && !action && !danger && <Icon name="chevron.right" glyph="›" size={13} color={theme.ink3} />}
    </>
  );
  const row = { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 46, paddingHorizontal: 16, paddingVertical: 10 } as const;
  if (!onPress) return <View style={row}>{body}</View>;
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      // a held row darkens like a native list cell
      feel="row"
      rowColor={theme.line}
      style={[row, disabled && { opacity: 0.45 }]}
    >
      {body}
    </Tap>
  );
}
