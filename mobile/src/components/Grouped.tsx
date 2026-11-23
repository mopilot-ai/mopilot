// Claude for iOS's sheet lists: a grey group label, 22 pt rounded cards of rows, each with a glyph, a title and its grey line, a value, a chevron or a check.
import { useLargeText } from '../useLargeText';
import type { ReactElement, ReactNode } from 'react';
import { Children, Fragment } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import { typo } from '../typography';

/** The grey label above a group ("Computers", "App"). */
export function GroupLabel({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Text accessibilityRole="header" style={{ ...typo.subhead, color: theme.ink2, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 8 }}>
      {children}
    </Text>
  );
}

/** A row's side padding, its glyph column and the gap after it: where its title starts. */
const ROW_PAD = 16;
const ICON_COLUMN = 24;
const ROW_GAP = 14;

/**
 * Rows on one rounded card, with a hairline between them. As in Claude's Settings sheet the hairline is inset: it starts where the row
 * above it starts its title (after the glyph, when it has one) and stops a row padding short of the card's edge. (The "no dividers" rule
 * of the design tokens is for lists of sessions, which have none.)
 */
export function Group({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={{ borderRadius: 22, backgroundColor: theme.surface, overflow: 'hidden', marginBottom: 16 }}>
      {rows.map((row, i) => (
        <Fragment key={(row as ReactElement).key}>
          {i > 0 && (
            <View
              style={{
                borderTopWidth: 1,
                borderTopColor: theme.line,
                marginLeft: ROW_PAD + ((rows[i - 1] as ReactElement<{ icon?: ReactNode }>).props?.icon ? ICON_COLUMN + ROW_GAP : 0),
                marginRight: ROW_PAD,
              }}
            />
          )}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

/** One row of a group. `end` is what sits at its right edge: a chevron (opens a page), a check (the chosen one) or nothing. */
export function GroupItem({
  title,
  detail,
  value,
  badge,
  say,
  label,
  icon,
  end = 'none',
  tone = 'ink',
  onPress,
  trailing,
  muted = false,
}: {
  title: string;
  /** the grey line under the title */
  detail?: string;
  /** the grey value before the end mark ("System") */
  value?: string;
  /** a small grey pill before the value ("Recommended") */
  badge?: string;
  /** a state the row shows another way (the grey line) that VoiceOver says after the name ("At its limit") */
  say?: string;
  /** what VoiceOver says for the row, when the name alone does not say what it acts on ("Hide: Reply to Sam") */
  label?: string;
  icon?: ReactNode;
  end?: 'chevron' | 'check' | 'none';
  /** 'link' is the blue of an action row (Add a computer), 'danger' the red of Sign out */
  tone?: 'ink' | 'link' | 'danger';
  onPress?: () => void;
  /** a control in place of the end mark, such as a switch */
  trailing?: ReactNode;
  /** an option that cannot be chosen now (its reason is the grey line): drawn quieter and read as dimmed, still pressable to show why */
  muted?: boolean;
}) {
  const theme = useTheme();
  const large = useLargeText();
  const ink = muted ? theme.ink3 : tone === 'link' ? theme.accent : tone === 'danger' ? theme.bad : theme.ink;
  const body = (
    <>
      {icon && <View style={{ width: ICON_COLUMN, alignItems: 'center' }}>{icon}</View>}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ ...typo.body, color: ink, textAlign: tone === 'danger' && !icon ? 'center' : 'left' }}>{title}</Text>
        {!!detail && <Text style={{ ...typo.subhead, color: theme.ink2 }}>{detail}</Text>}
        {/* at large text the value (a state word) goes under the name: beside it, it would take the width and leave the name a letter a line */}
        {large && !!value && <Text style={{ ...typo.callout, color: theme.ink2 }}>{value}</Text>}
      </View>
      {!!badge && (
        <View style={{ backgroundColor: theme.sunken, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}>
          <Text style={{ ...typo.subhead, color: theme.ink2 }}>{badge}</Text>
        </View>
      )}
      {!large && !!value && (
        <Text numberOfLines={1} style={{ ...typo.callout, color: theme.ink2, flexShrink: 1 }}>
          {value}
        </Text>
      )}
      {trailing}
      {!trailing && end === 'chevron' && <Icon name="chevron.right" glyph="›" size={13} color={theme.ink3} />}
      {!trailing && end === 'check' && <Icon name="checkmark" glyph="✓" size={16} color={theme.accent} />}
    </>
  );
  const row = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
    minHeight: 52,
    paddingHorizontal: ROW_PAD,
    paddingVertical: 13,
  } as const;
  // a row that only says something reads as one element when it has a state to say after its name
  if (!onPress)
    return say ? (
      <View accessible accessibilityLabel={[title, badge, say, value].filter(Boolean).join(', ')} style={row}>
        {body}
      </View>
    ) : (
      <View style={row}>{body}</View>
    );
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label ?? [title, badge, say, value].filter(Boolean).join(', ')}
      accessibilityState={
        end === 'check' || muted ? { ...(end === 'check' ? { selected: true } : {}), ...(muted ? { disabled: true } : {}) } : undefined
      }
      onPress={onPress}
      feel="row"
      rowColor={theme.sunken}
      style={row}
    >
      {body}
    </Tap>
  );
}
