// Shared mobile controls and calm, readable visual tokens.
import React from 'react';
import { KeyboardAvoidingView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { dark, light, useTheme, type Theme } from '../theme';
import { typo, typoEyebrow } from '../typography';
import { PerfFrame } from './PerfProbe';
const makeStyles = (colors: Theme) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.bg },
    body: { padding: 20, gap: 16 },
    title: { ...typo.title1Bold, color: colors.ink },
    largeTitle: { ...typo.title1Bold, color: colors.ink },
    heading: { ...typo.bodySemibold, color: colors.ink },
    text: { ...typo.callout, color: colors.ink },
    muted: { ...typo.subhead, color: colors.ink2 },
    card: { backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.line, padding: 16, gap: 10 },
    input: {
      minHeight: 48,
      backgroundColor: colors.surface,
      borderColor: colors.line,
      borderWidth: 1,
      borderRadius: 10,
      padding: 12,
      ...typo.callout,
      color: colors.ink,
    },
    button: {
      minHeight: 46,
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: colors.btn,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonText: { color: colors.btnInk, ...typo.subheadSemibold },
    secondary: { backgroundColor: colors.sunken },
    secondaryText: { color: colors.ink },
    dangerButton: { backgroundColor: colors.bad },
    dangerText: { color: colors.surface },
    // a main action that cannot be used now is a flat grey button, not a faded dark one that looks pressed
    mainDisabled: { backgroundColor: colors.sunken },
    mainDisabledText: { color: colors.ink3 },
    quietDangerText: { color: colors.bad },
    error: { color: colors.bad, ...typo.subhead },
    // a diff's added and removed rows are tinted as well as marked with +/− and underline/strike, so colour is never the only cue
    diffAdd: { backgroundColor: colors.addBg },
    diffDel: { backgroundColor: colors.delBg },
    row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  });
const lightStyles = makeStyles(light);
const darkStyles = makeStyles(dark);
export const useStyles = () => (useTheme() === dark ? darkStyles : lightStyles);

/**
 * The frame every screen sits in: the window's full height, inside the side insets, and lifted above the keyboard so a
 * bottom bar (the composer, the terminal input, the actions of pairing and a new chat) is never under it. The status bar
 * and home indicator are each screen's to keep clear (`useScreenInsets`), so Chats and its drawer can run under them as
 * Claude's do.
 */
export function ScreenFrame({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider>
      <InsetFrame>
        <PerfFrame>{children}</PerfFrame>
      </InsetFrame>
    </SafeAreaProvider>
  );
}

function InsetFrame({ children }: { children: React.ReactNode }) {
  const styles = useStyles();
  const { left, right, bottom } = useSafeAreaInsets();
  return (
    <View style={[styles.page, { paddingLeft: left, paddingRight: right }]}>
      {/* edge-to-edge Android does not shrink the window for the keyboard either (checked on an emulator: pairing's Continue sat under it and the page could not scroll to it).
          Every screen already keeps the home indicator's height clear at its bottom, which the keyboard covers, so the lift leaves that out */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={-bottom}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

/** The padding that keeps a screen's content clear of the status bar and the home indicator. */
export function useScreenInsets() {
  const { top, bottom } = useSafeAreaInsets();
  return { paddingTop: top, paddingBottom: bottom };
}
/** How long a choice that must be held (a payment, a login) is pressed before it counts. */
export const HOLD_MS = 1000;

export function Button({
  title,
  onPress,
  disabled = false,
  secondary = false,
  danger = false,
  quietDanger = false,
  selected,
  label,
  hold = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  /** A destructive action: drawn in the danger colour. */
  danger?: boolean;
  /** A refusal that is not a destruction: red text on the secondary fill, so it does not compete with the main action. */
  quietDanger?: boolean;
  /** A choice that can be picked: announced as selected, in addition to the visible mark. */
  selected?: boolean;
  /** What a screen reader says when the visible title alone is not enough ("Remove Studio Mac"). */
  label?: string;
  /** A choice the Mac says must be held (a payment, a login): it answers only to a long press, and a screen reader is offered that as an action. */
  hold?: boolean;
}) {
  const styles = useStyles();
  const main = !secondary && !danger;
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label ?? title.replace(/^✓ /, '')}
      accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
      accessibilityHint={hold ? 'Press and hold to confirm' : undefined}
      disabled={disabled}
      onPress={hold ? undefined : onPress}
      onLongPress={hold ? onPress : undefined}
      delayLongPress={HOLD_MS}
      // VoiceOver's double tap is a plain press: a held choice offers the long press as an action instead
      accessibilityActions={hold ? [{ name: 'longpress' }] : undefined}
      onAccessibilityAction={hold ? onPress : undefined}
      // a press dims the button at once and it comes back when released, as the references' buttons do
      style={[
        styles.button,
        secondary && styles.secondary,
        danger && styles.dangerButton,
        disabled && (main ? styles.mainDisabled : { opacity: 0.45 }),
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          secondary && styles.secondaryText,
          danger && styles.dangerText,
          quietDanger && styles.quietDangerText,
          disabled && main && styles.mainDisabledText,
        ]}
      >
        {title}
      </Text>
      {hold && <Text style={[styles.buttonText, secondary && styles.secondaryText, { ...typo.caption2 }]}>Hold to confirm</Text>}
    </Tap>
  );
}
export function Field(props: React.ComponentProps<typeof TextInput>) {
  const styles = useStyles();
  const colors = useTheme();
  return (
    <TextInput
      placeholderTextColor={colors.ink2}
      {...props}
      accessibilityLabel={props.accessibilityLabel ?? props.placeholder}
      style={[styles.input, props.style]}
    />
  );
}
/** A section heading: announced as a heading so a screen reader can jump between sections. */
export function Heading({ children }: { children: React.ReactNode }) {
  const styles = useStyles();
  return (
    <Text accessibilityRole="header" style={styles.heading}>
      {children}
    </Text>
  );
}
/** A screen's title. */
export function Title({ children }: { children: React.ReactNode }) {
  const styles = useStyles();
  return (
    <Text accessibilityRole="header" style={styles.title}>
      {children}
    </Text>
  );
}
/** A small caps label above a group of rows, announced as a heading. */
export function SectionLabel({ children }: { children: string }) {
  const colors = useTheme();
  return (
    <Text accessibilityRole="header" style={{ ...typoEyebrow, textTransform: 'uppercase', color: colors.ink3, marginTop: 6 }}>
      {children}
    </Text>
  );
}
/** A tab screen's large title, as in a native navigation bar. */
export function LargeTitle({ children }: { children: React.ReactNode }) {
  const styles = useStyles();
  return (
    <Text accessibilityRole="header" style={styles.largeTitle}>
      {children}
    </Text>
  );
}
export function ErrorLine({ text }: { text: string | null }) {
  const styles = useStyles();
  return text ? (
    <Text accessibilityRole="alert" style={styles.error}>
      {text}
    </Text>
  ) : null;
}
export function Card({ children }: { children: React.ReactNode }) {
  const styles = useStyles();
  return <View style={styles.card}>{children}</View>;
}

/** A setting that is on or off: its name and a native switch, as in iOS Settings, instead of a button that names its state. */
export function ToggleRow({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  const styles = useStyles();
  const colors = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}>
      <Text style={[styles.text, { flex: 1 }]}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ true: colors.ok, false: colors.sunken }}
      />
    </View>
  );
}
