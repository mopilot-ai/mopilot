// A labelled single-choice list as rows with a check on the chosen one; it draws nothing when the Mac offered no choices.
import { Icon } from './Icon';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useTheme } from '../theme';
import { typo, typoEyebrow, typoWeight } from '../typography';

export type Option = { id: string; label: string; hint?: string; disabled?: string };

export function Choice({
  title,
  options,
  value,
  pick,
  locked = false,
}: {
  title: string;
  options: Option[];
  value: string | null;
  pick: (id: string) => void;
  /** Every choice is held while a pick is being saved, without a reason line under each. */
  locked?: boolean;
}) {
  const theme = useTheme();
  if (!options.length) return null;
  const chosen = options.find((o) => o.id === value);
  return (
    <View style={{ gap: 4 }}>
      <Text accessibilityRole="header" style={{ ...typoEyebrow, textTransform: 'uppercase', color: theme.ink3 }}>
        {title}
      </Text>
      <View style={{ backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.line, overflow: 'hidden' }}>
        {options.map((o, i) => {
          const held = locked || !!o.disabled;
          const on = o.id === value;
          return (
            <Tap
              key={o.id}
              accessibilityRole="button"
              accessibilityLabel={o.label}
              // why it cannot be chosen is read with it
              accessibilityHint={o.disabled}
              accessibilityState={{ selected: on, disabled: held }}
              disabled={held}
              onPress={() => pick(o.id)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                minHeight: 48,
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: theme.line,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    ...typo.subhead,
                    fontWeight: on ? typoWeight.semibold : typoWeight.medium,
                    color: theme.ink,
                    opacity: held && !locked ? 0.5 : locked ? 0.6 : 1,
                  }}
                >
                  {o.label}
                </Text>
                {!!o.disabled && <Text style={{ ...typo.caption, color: theme.ink3 }}>{o.disabled}</Text>}
              </View>
              {/* the mark and the selected state say which is chosen; the weight is a third cue */}
              {on && <Icon name="checkmark" glyph="✓" size={16} color={theme.accent} />}
            </Tap>
          );
        })}
      </View>
      {!!chosen?.hint && <Text style={{ ...typo.footnote, color: theme.ink3, paddingHorizontal: 4 }}>{chosen.hint}</Text>}
    </View>
  );
}
