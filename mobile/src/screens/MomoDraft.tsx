// A draft MoMo wrote for the user, as a card in MoMo's chat on the classic phone (A3): who it is for, its subject and its words, with Edit, Copy and one button that opens the draft where the phone can: the mail app (the share sheet when it cannot); with Gmail installed the person picks Gmail's compose, the mail app or the share sheet once, and the pick is the button's one tap next time, the chooser staying behind a chevron (momo/draftOpener.ts says why). Edit changes the words on this card only; Copy uses the phone's clipboard. Nothing is saved, sent or asked of the Mac, and there is no send control: a draft the user sent on the Mac shows read only, from where it went and how far it got (asked, chosen, sent), with no buttons left.
import { useEffect, useState } from 'react';
import { Linking, Share, Text, TextInput, View } from 'react-native';
import Animated, { Easing, FadeIn, useReducedMotion } from 'react-native-reanimated';
import { ButtonRow } from './ButtonRow';
import { Tap } from '../ui/ds/Tap';
import { Icon } from '../components/Icon';
import { copyText } from '../platform/clipboard';
import { readDraft, MAX_BODY, CODES, type Draft } from '../../../shared/momoDraft.mjs';
import { fromName, sendLines, type Send } from '../../../shared/momoDraftSend.mjs';
import { MOMO_DUR, MOMO_EASE } from '../../../shared/momoMotion.mjs';
import { draftPick } from '../platform/draftPick';
import { GMAIL_PROBE, runPlan, stepsFor, viewOf, wordOf, type Pick } from '../momo/draftOpener';
import { useTheme } from '../theme';
import { useTranslation } from '../ui/i18n';
import { typo } from '../typography';

function Pill({
  title,
  strong,
  onPress,
  label,
  narrow,
}: {
  title: string;
  strong?: boolean;
  onPress: () => void;
  label?: string;
  narrow?: boolean;
}) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      onPress={onPress}
      style={[
        {
          ...(narrow ? { width: 44 } : { flex: 1 }),
          minHeight: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: strong ? theme.btn : theme.sunken,
        },
      ]}
    >
      <Text style={{ ...typo.calloutMedium, color: strong ? theme.btnInk : theme.ink }}>{title}</Text>
    </Tap>
  );
}

/** One line of how far a send got, arriving as MoMo's replies do (the shared motion tokens; still with Reduce Motion). */
function SendLine({ code, send, last }: { code: ReturnType<typeof sendLines>[number]; send: Send; last: boolean }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const key = { asked: 'sendAsked', chose: 'sendChose', sent: 'sendSent', unsure: 'sendUnsure' }[code];
  return (
    <Animated.View entering={reduce ? undefined : FadeIn.duration(MOMO_DUR.m).easing(Easing.bezier(...MOMO_EASE.out))}>
      <Text style={{ ...typo.subhead, color: last ? theme.ink : theme.ink2 }}>{t(`momoDraft.${key}`, { from: fromName(send.from) })}</Text>
    </Animated.View>
  );
}

export function DraftCard({ draft, send = null }: { draft: Draft; send?: Send | null }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [shown, setShown] = useState(draft);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [line, setLine] = useState<{ text: string; bad: boolean } | null>(null);
  // whether Gmail is installed (iOS answers only once its scheme is declared in the build: app.json), so until then the plan starts at the mail app
  const [gmail, setGmail] = useState(false);
  // the way the person last opened a draft on this phone, and whether the chooser is showing
  const [remembered, setRemembered] = useState<Pick | null>(null);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    Linking.canOpenURL(GMAIL_PROBE).then(setGmail, () => setGmail(false));
    void draftPick.get().then(setRemembered);
  }, []);
  const view = viewOf(shown, gmail, remembered);
  const forget = () => {
    setRemembered(null);
    void draftPick.forget();
  };
  // a remembered Gmail that is no longer installed is dropped, and the default order applies
  useEffect(() => {
    if (!view.forget) return;
    setRemembered(null);
    void draftPick.forget();
  }, [view.forget]);
  const people = shown.to.length;

  const done = () => {
    const read = readDraft({ to: shown.to, subject, body });
    if (!read.ok) return setLine({ text: read.reason === CODES.TOO_LONG ? t('momoDraft.long') : t('momoDraft.empty'), bad: true });
    setShown(read.draft);
    setEditing(false);
    setLine(null);
  };
  const cancel = () => {
    setSubject(shown.subject);
    setBody(shown.body);
    setEditing(false);
    setLine(null);
  };
  const copy = async () =>
    setLine((await copyText(shown.body)) ? { text: t('momoDraft.copied'), bad: false } : { text: t('momoDraft.noCopy'), bad: true });
  /** Opens by `pick` (none: the default order); with the chooser in play, a pick that opened is remembered and one that could not is dropped. */
  const open = async (pick: Pick | null) => {
    setChoosing(false);
    const opened = await runPlan(stepsFor(shown, gmail, pick), shown, {
      open: (url) => Linking.openURL(url),
      share: (message) => Share.share({ message }),
    });
    setLine(opened ? null : { text: t('momoDraft.noMail'), bad: true });
    if (!opened || !pick || !view.choose) return;
    if (opened.via === pick) {
      setRemembered(pick);
      void draftPick.set(pick);
    } else if (remembered === pick) forget();
  };
  const field = {
    ...typo.body,
    color: theme.ink,
    backgroundColor: theme.sunken,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  };

  return (
    <View
      accessibilityLabel={t('momoDraft.title')}
      style={{
        backgroundColor: theme.surface,
        borderWidth: 1,
        borderColor: theme.line,
        borderRadius: 20,
        padding: 14,
        marginBottom: 14,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="envelope" glyph="✉" size={14} color={theme.ink} />
        <Text style={{ ...typo.calloutSemibold, color: theme.ink }}>{t('momoDraft.title')}</Text>
      </View>
      <Text style={{ ...typo.subhead, color: theme.ink2 }}>
        {people > 1 ? t('momoDraft.toCount', { count: people }) : t('momoDraft.to')}
      </Text>
      <Text selectable style={{ ...typo.body, color: people ? theme.ink : theme.ink3 }}>
        {people ? shown.to.join(', ') : t('momoDraft.noRecipient')}
      </Text>
      <Text style={{ ...typo.subhead, color: theme.ink2 }}>{t('momoDraft.subject')}</Text>
      {editing ? (
        <TextInput value={subject} onChangeText={setSubject} accessibilityLabel={t('momoDraft.subject')} style={field} />
      ) : (
        <Text selectable style={{ ...typo.body, color: shown.subject ? theme.ink : theme.ink3 }}>
          {shown.subject || t('momoDraft.noSubject')}
        </Text>
      )}
      {editing ? (
        <TextInput
          value={body}
          onChangeText={setBody}
          accessibilityLabel={t('momoDraft.text')}
          multiline
          maxLength={MAX_BODY}
          style={{ ...field, minHeight: 140, textAlignVertical: 'top' }}
        />
      ) : (
        <Text selectable style={{ ...typo.body, color: theme.ink }}>
          {shown.body}
        </Text>
      )}
      {send ? (
        <View accessibilityLiveRegion="polite">
          <Text style={{ ...typo.subhead, color: theme.ink2 }}>{t('momoDraft.from')}</Text>
          <Text selectable style={{ ...typo.body, color: theme.ink }}>
            {fromName(send.from)}
          </Text>
          {sendLines(send).map((code, i, all) => (
            <SendLine key={code} code={code} send={send} last={i === all.length - 1} />
          ))}
        </View>
      ) : (
        <ButtonRow top={4}>
          {editing ? (
            <>
              <Pill title={t('momoDraft.cancel')} onPress={cancel} />
              <Pill title={t('momoDraft.done')} strong onPress={done} />
            </>
          ) : (
            <>
              <Pill title={t('momoDraft.edit')} onPress={() => setEditing(true)} />
              <Pill title={t('momoDraft.copy')} onPress={() => void copy()} />
              <Pill
                title={t(`momoDraft.${wordOf(view.primary)}`)}
                strong
                onPress={() => (view.primary ? void open(view.primary) : setChoosing((was) => !was))}
              />
              {view.choose && view.primary ? (
                <Pill title="⌄" label={t('momoDraft.chooser')} narrow onPress={() => setChoosing((was) => !was)} />
              ) : null}
            </>
          )}
        </ButtonRow>
      )}
      {choosing && !editing && !send ? (
        <ButtonRow top={0}>
          {view.options.map((pick) => (
            <Pill key={pick} title={t(`momoDraft.pick_${pick}`)} onPress={() => void open(pick)} />
          ))}
        </ButtonRow>
      ) : null}
      {line ? (
        <Text
          accessibilityRole={line.bad ? 'alert' : undefined}
          accessibilityLiveRegion="polite"
          style={{ ...typo.subhead, color: theme.ink2 }}
        >
          {line.text}
        </Text>
      ) : null}
    </View>
  );
}
