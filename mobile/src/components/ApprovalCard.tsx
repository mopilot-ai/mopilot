// An approval in the chat as Claude for iOS draws it: the amber hand and the question, the exact command in mono, Deny beside the narrowest Allow, and the card's other choices under More options.
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { APPROVAL_OFFLINE_LINE, useMacLink } from '../macLink';
import { monoFamily } from '../fonts';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import type { CardData } from './RequestCard';
import { TargetLine } from './TargetLine';
import { HOLD_MS } from './ui';
import { useLargeText } from '../useLargeText';
import { typo } from '../typography';

type Choice = NonNullable<CardData['choices']>[number];

/** One 44 pt pill: the primary one in ink, the others on the grey fill. A `hold` pill answers only to a long press, and says so. */
function Pill({
  title,
  onPress,
  primary = false,
  disabled,
  hold = false,
}: {
  title: string;
  onPress: () => void;
  primary?: boolean;
  disabled: boolean;
  hold?: boolean;
}) {
  const theme = useTheme();
  // at a large text size the label wraps instead of being cut ("Allo…"), and the button takes the row to itself (the card stacks them)
  const large = useLargeText();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={hold ? 'Press and hold to confirm' : undefined}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={hold ? undefined : onPress}
      onLongPress={hold ? onPress : undefined}
      // VoiceOver's double tap is a plain press: a held choice offers the long press as an action instead
      accessibilityActions={hold ? [{ name: 'longpress' }] : undefined}
      onAccessibilityAction={hold ? onPress : undefined}
      delayLongPress={HOLD_MS}
      style={{
        ...(large ? { alignSelf: 'stretch' as const } : { flex: 1 }),
        minHeight: 44,
        borderRadius: 22,
        paddingHorizontal: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: primary ? theme.btn : theme.sunken,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text
        numberOfLines={large ? undefined : 1}
        style={{ ...typo.calloutMedium, color: primary ? theme.btnInk : theme.ink, textAlign: 'center' }}
      >
        {title}
      </Text>
      {hold && <Text style={{ ...typo.caption2, color: primary ? theme.btnInk : theme.ink2 }}>Hold to confirm</Text>}
    </Tap>
  );
}

/** The layout of a card's own choices: the narrowest allow is primary, the first refusal is Deny, the rest wait under More options. */
export function approvalLayout(choices: readonly Choice[]): { allow: Choice | null; deny: Choice | null; more: Choice[] } {
  const allow = choices.find((c) => !c.deny) ?? null;
  const deny = choices.find((c) => c.deny) ?? null;
  return { allow, deny, more: choices.filter((c) => c !== allow && c !== deny) };
}

/** A card that is a plain approval: choices to pick and nothing to fill in or read first. */
export const isApproval = (card: CardData) =>
  card.kind !== 'plan' &&
  !card.inApp &&
  !card.url &&
  !card.questions?.length &&
  !card.schema?.properties &&
  Array.isArray(card.choices) &&
  card.choices.length > 0;

/**
 * Renders exactly the choices the card offers, with their own labels, and answers with the key the card gave. "Deny with
 * comment" refuses with the card's Deny and hands the composer to the person (`comment`). While the Mac is away the
 * buttons are off and say why (unless the card came through the machine itself); an answer in flight disables them until the card goes.
 */
export function ApprovalCard({
  card,
  answer,
  comment,
}: {
  card: CardData;
  answer: (key: string) => Promise<boolean>;
  /** Called after a refusal from "Deny with comment": the composer takes focus for what to do instead. */
  comment: () => void;
}) {
  const theme = useTheme();
  // a card the machine's own path brought is answered there, so the Mac being away does not hold it
  const online = useMacLink().online || card.viaMachine === true;
  const [more, setMore] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const { allow, deny, more: rest } = approvalLayout(card.choices ?? []);
  async function pick(key: string, then?: () => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    let done = false;
    try {
      done = await answer(key);
    } finally {
      inFlight.current = false;
      // an accepted answer leaves the card disabled until the Mac takes it down
      if (!done) setPending(false);
    }
    if (done) then?.();
  }
  const off = pending || !online;
  const large = useLargeText();
  return (
    <View
      style={{
        backgroundColor: theme.surface,
        borderWidth: 1,
        borderColor: theme.line,
        borderRadius: 20,
        padding: 14,
        marginTop: 6,
        marginBottom: 14,
        gap: 12,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="hand.raised" glyph="✋" size={16} color={theme.amber} />
        <Text accessibilityRole="header" style={{ flex: 1, ...typo.calloutSemibold, color: theme.ink }}>
          {card.title}
        </Text>
      </View>
      <TargetLine card={card} />
      {!!card.detail && (
        <Text
          selectable
          style={{
            fontFamily: monoFamily(),
            ...typo.footnote,
            color: theme.ink,
            backgroundColor: theme.sunken,
            borderRadius: 12,
            paddingHorizontal: 11,
            paddingVertical: 9,
            overflow: 'hidden',
          }}
        >
          {card.detail}
        </Text>
      )}
      <View style={{ flexDirection: large ? 'column' : 'row', gap: 8 }}>
        {deny && <Pill title={deny.label} hold={deny.hold} disabled={off} onPress={() => void pick(deny.key)} />}
        {allow && <Pill primary title={allow.label} hold={allow.hold} disabled={off} onPress={() => void pick(allow.key)} />}
      </View>
      {more ? (
        <View style={{ gap: 8 }}>
          {rest.map((choice) => (
            <View key={choice.key} style={{ flexDirection: 'row' }}>
              <Pill title={choice.label} hold={choice.hold} disabled={off} onPress={() => void pick(choice.key)} />
            </View>
          ))}
          {deny && (
            <View style={{ flexDirection: 'row' }}>
              <Pill title="Deny with comment" disabled={off} onPress={() => void pick(deny.key, comment)} />
            </View>
          )}
        </View>
      ) : (
        (rest.length > 0 || !!deny) && (
          <Tap
            accessibilityRole="button"
            accessibilityLabel="More options"
            onPress={() => setMore(true)}
            style={{ minHeight: 36, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ ...typo.subhead, color: theme.ink2 }}>More options</Text>
          </Tap>
        )
      )}
      {!online && <Text style={{ ...typo.footnote, color: theme.ink2, textAlign: 'center' }}>{APPROVAL_OFFLINE_LINE}</Text>}
    </View>
  );
}
