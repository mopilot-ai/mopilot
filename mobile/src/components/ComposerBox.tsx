// Claude for iOS's composer shell: chips above, a 28 pt rounded box with the field on top and a bar under it (+, the model pill, then the send or stop button).
import { KeyboardMinimize } from './KeyboardMinimize';
import type { ReactNode } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { GrowingField } from './GrowingField';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import { typo, typoScale } from '../typography';

/** One line of the message field: the body's line height and its 2 + 12 pt of padding. */
const LINE = typoScale.body.lineHeight + 14;

/** A 40 pt round control in the composer's bar: the grey one (attach, dictate) or the ink one (send, stop). */
export function ComposerButton({
  label,
  onPress,
  icon,
  strong = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  icon: ReactNode;
  /** the ink-filled send / stop button */
  strong?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        {
          width: 40,
          aspectRatio: 1,
          borderRadius: 20,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: strong ? theme.btn : theme.sunken,
        },
        disabled && { opacity: 0.45 },
      ]}
    >
      {icon}
    </Tap>
  );
}

/** The model pill in the bar: the model's name and a quieter second word (the effort). */
export function ModelPill({ model, detail, onPress }: { model: string; detail?: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={`Model, ${[model, detail].filter(Boolean).join(' ')}`}
      onPress={onPress}
      style={[
        {
          minHeight: 40,
          borderRadius: 20,
          paddingHorizontal: 16,
          // gives way at large text (the words end in …) instead of pushing the send end out of the box
          flexShrink: 1,
          minWidth: 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
          backgroundColor: theme.sunken,
        },
      ]}
    >
      <Text numberOfLines={1} style={{ ...typo.subhead, color: theme.ink, flexShrink: 1 }}>
        {model}
      </Text>
      {!!detail && (
        <Text numberOfLines={1} style={{ ...typo.subhead, color: theme.ink2 }}>
          {detail}
        </Text>
      )}
    </Tap>
  );
}

/** The shell. The caller owns the text and what each control does; `bar` sits between + and the send end (normally a ModelPill). */
export function ComposerBox({
  value,
  onChangeText,
  placeholder,
  onAttach,
  bar,
  end,
  chips,
  tray,
  above,
  fieldProps,
  editable = true,
  inputRef,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  /** shows the + button when present */
  onAttach?: () => void;
  bar?: ReactNode;
  /** the right end of the bar: the mic, then send or stop */
  end?: ReactNode;
  /** the chips row above the box */
  chips?: ReactNode;
  /** the attached files, as thumbnails at the top of the box */
  tray?: ReactNode;
  /** Above the box, under the chips: the / and @ menus. */
  above?: ReactNode;
  /** More for the message field: a screen that watches the caret (the / and @ menus) takes the text and the selection itself. */
  fieldProps?: Partial<React.ComponentProps<typeof TextInput>>;
  editable?: boolean;
  inputRef?: React.ComponentProps<typeof TextInput>['ref'];
}) {
  const theme = useTheme();
  return (
    <View style={{ flexShrink: 1, minHeight: 0, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 }}>
      {chips ? <View style={{ flexShrink: 0, flexDirection: 'row', gap: 8, marginBottom: 10 }}>{chips}</View> : null}
      {above ? <View style={{ marginBottom: 10, flexShrink: 1, minHeight: 0 }}>{above}</View> : null}
      <View
        style={{
          flexShrink: 0,
          borderRadius: 28,
          borderWidth: 1,
          borderColor: theme.line,
          backgroundColor: theme.surface,
          paddingTop: 12,
          paddingBottom: 10,
          paddingLeft: 16,
          paddingRight: 12,
          boxShadow: '0px 2px 12px rgba(0, 0, 0, 0.04)',
        }}
      >
        {tray ? <View style={{ marginBottom: 10, flexShrink: 1, minHeight: 0 }}>{tray}</View> : null}
        <GrowingField
          input={TextInput}
          minHeight={LINE}
          maxHeight={160}
          ref={inputRef}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.ink3}
          accessibilityLabel={placeholder}
          editable={editable}
          multiline
          {...fieldProps}
          style={{ ...typo.body, color: theme.ink, paddingTop: 2, paddingBottom: 12 }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {onAttach && (
            <ComposerButton label="Add to session" onPress={onAttach} icon={<Icon name="plus" glyph="+" size={18} color={theme.ink} />} />
          )}
          {bar}
          <View style={{ flex: 1 }} />
          <KeyboardMinimize />
          {end}
        </View>
      </View>
    </View>
  );
}
