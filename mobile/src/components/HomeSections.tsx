// The Chats home's own pieces, as Claude for iOS's Sessions draws them: the white "+ New session" capsule at the top, the white inset card a group of rows sits in (hairlines between them).
import { Children, type ReactElement, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useTheme } from '../theme';
import { HOME_LAYOUT_WORD, HOME_LAYOUTS, type HomeLayout } from '../homeLayout';
import { Icon } from './Icon';
import { Segmented } from './Segmented';
import { typo } from '../typography';

/** Rows in Claude's inset grouped card: white (a raised grey on dark), rounded, an inset hairline between rows; the rows keep their own content. */
export function GroupCard({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ marginHorizontal: 16, borderRadius: 22, overflow: 'hidden', backgroundColor: theme.surface }}>
      {Children.toArray(children).map((row, i) => (
        // Children.toArray keys every child (by its own key, else its place), so a row keeps its wrapper as the list moves
        <View key={(row as ReactElement).key}>
          {i > 0 && <View style={{ marginLeft: 24, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }} />}
          {row}
        </View>
      ))}
    </View>
  );
}

export function NewSessionRow({ onPress, disabled = false }: { onPress: () => void; disabled?: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
      <Tap
        accessibilityRole="button"
        accessibilityLabel="New session"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        style={{
          minHeight: 52,
          borderRadius: 26,
          paddingHorizontal: 22,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          backgroundColor: theme.surface,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Icon name="plus" glyph="+" size={16} color={theme.ink2} />
        <Text style={{ ...typo.body, color: theme.ink }}>New session</Text>
      </Tap>
    </View>
  );
}

/** By project (as the Mac's sidebar) or by state: two words on a segmented control under + New session. */
export function LayoutSwitch({ layout, choose }: { layout: HomeLayout; choose: (next: HomeLayout) => void }) {
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
      <Segmented items={HOME_LAYOUTS.map((key) => ({ key, label: HOME_LAYOUT_WORD[key], onPress: () => choose(key) }))} selected={layout} />
    </View>
  );
}

/** The row under a project's chats when it has more than its first few: "Show N more" (the count it reveals) or "Show less", as the Mac's sidebar words them. */
export function ProjectFoot({
  foot,
  project,
  onMore,
  onLess,
}: {
  foot: { kind: 'more'; count: number } | { kind: 'less' };
  project: string;
  onMore: () => void;
  onLess: () => void;
}) {
  const theme = useTheme();
  const more = foot.kind === 'more';
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={more ? `Show ${foot.count} more in ${project}` : `Show less in ${project}`}
      onPress={more ? onMore : onLess}
      feel="row"
      rowColor={theme.sunken}
      style={{ paddingVertical: 12, paddingHorizontal: 24 }}
    >
      <Text style={{ ...typo.subhead, color: theme.ink2 }}>{more ? `Show ${foot.count} more` : 'Show less'}</Text>
    </Tap>
  );
}
