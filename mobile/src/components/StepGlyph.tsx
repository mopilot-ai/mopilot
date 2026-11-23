// The round glyph at the left of a steps row, as Claude draws it: a 24 pt circle with a thin stroke and the kind of work in it (a globe for the web, a terminal for commands).
import { View } from 'react-native';
import type { Kind } from '../presentation/toolRuns';
import { useTheme } from '../theme';
import { Icon } from './Icon';

/** The SF Symbol and the text fallback of each kind of step. */
const GLYPH: Record<Kind, { name: Parameters<typeof Icon>[0]['name']; glyph: string }> = {
  read: { name: 'doc.text', glyph: '▤' },
  search: { name: 'magnifyingglass', glyph: '⌕' },
  edit: { name: 'pencil', glyph: '✎' },
  run: { name: 'terminal', glyph: '›' },
  web: { name: 'globe', glyph: '◍' },
  other: { name: 'ellipsis', glyph: '…' },
};

export function StepGlyph({ kind }: { kind: Kind }) {
  const theme = useTheme();
  const { name, glyph } = GLYPH[kind];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.line,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={name} glyph={glyph} size={12} color={theme.ink2} />
    </View>
  );
}
