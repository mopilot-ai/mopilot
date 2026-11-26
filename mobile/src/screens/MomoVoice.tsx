// A voice note for MoMo's chat on the classic phone (A5): the coding chat's recorder and transcribe path (remote/useVoiceNote.ts) pointed at the Mac's MoMo method, with its transcript put in the composer for the person to read and send. Nothing is sent here, and the recording is not kept anywhere.
import type { DraftHandle } from '../presentation/drafts';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { Icon } from '../components/Icon';
import { OpenSettings } from '../components/OpenSettings';
import { ErrorLine, useStyles } from '../components/ui';
import { Waveform } from '../components/Waveform';
import type { MobileRuntime } from '../contracts';
import type { Media } from '../platform/media';
import { useOwnedRequest } from '../remote/useOwnedRequest';
import { useVoiceNote } from '../remote/useVoiceNote';
import { useTheme } from '../theme';
import { useTranslation } from '../ui/i18n';

/** The Mac's method that turns a MoMo voice note into text; a Mac that does not list it shows no microphone. */
export const MOMO_VOICE_METHOD = 'momo.chat.transcribe';

export type MomoVoiceControl = ReturnType<typeof useVoiceNote>;

/** What the draft reads once a transcript is added: after what is already typed, on its own line of words. */
export const withTranscript = (draft: string, text: string) => (draft.trim() ? `${draft.trim()} ${text}` : text);

/**
 * The voice note the composer shows, or null for none: on while the Mac lists the method, and while a note is being recorded or read or
 * has failed (a Mac that went away mid-note still says so), so an uninvited account or an older Mac sees no microphone and no trace.
 */
export const voiceShown = (listed: boolean, voice: MomoVoiceControl | null) =>
  voice && (listed || voice.phase !== 'idle' || !!voice.error) ? voice : null;

/** Holds one voice note's state for the composer it wraps; mounted only where the phone can record and the Mac lists the method. */
export function MomoVoice({
  runtime,
  media,
  drafts,
  children,
}: {
  runtime: MobileRuntime;
  media: Media;
  /** the draft a transcript is added to */
  drafts: DraftHandle;
  children: (voice: MomoVoiceControl) => ReactNode;
}) {
  const request = useOwnedRequest(runtime);
  // the transcript arrives after the recording is sent and read: it goes after whatever is typed by then
  const voice = useVoiceNote({
    media,
    request,
    caps: null,
    method: MOMO_VOICE_METHOD,
    onText: (text) => drafts.set(withTranscript(drafts.get(), text)),
  });
  return <>{children(voice)}</>;
}

function Round({
  label,
  onPress,
  strong,
  disabled,
  children,
}: {
  label: string;
  onPress: () => void;
  strong?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        {
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: strong ? theme.orange : theme.sunken,
        },
        disabled && { opacity: 0.45 },
      ]}
    >
      {children}
    </Tap>
  );
}

/** The microphone in the composer's pill: it starts a recording; off while the Mac is away or the composer is held. */
export function MicButton({ voice, disabled }: { voice: MomoVoiceControl; disabled: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <Round label={t('momoVoice.record')} disabled={disabled || voice.waiting} onPress={() => void voice.start()}>
      <Icon name="mic" glyph="🎙" size={17} color={theme.ink} />
    </Round>
  );
}

/** The pill while a note is recorded (its level, Cancel and Stop) or read by the Mac (Cancel). */
export function VoicePill({ voice }: { voice: MomoVoiceControl }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useStyles();
  if (voice.phase === 'transcribing')
    return (
      <>
        <Text accessibilityLiveRegion="polite" style={[styles.muted, { flex: 1, paddingVertical: 8 }]}>
          {t('momoVoice.transcribing')}
        </Text>
        <Round label={t('momoVoice.cancelTranscribing')} onPress={voice.cancelTranscribing}>
          <Icon name="xmark" glyph="✕" size={15} color={theme.ink} />
        </Round>
      </>
    );
  return (
    <>
      <View style={{ flex: 1, paddingVertical: 8 }}>
        <Waveform meter={voice.meter} />
      </View>
      <Round label={t('momoVoice.cancel')} onPress={() => void voice.discard()}>
        <Icon name="xmark" glyph="✕" size={15} color={theme.ink} />
      </Round>
      <Round label={t('momoVoice.stop')} strong onPress={() => void voice.stop()}>
        <Icon name="checkmark" glyph="✓" size={17} color={theme.accentInk} />
      </Round>
    </>
  );
}

/** Above the pill: what the microphone prompt waits for, why a try failed, and the way to Settings when the microphone was refused. */
export function VoiceNotices({ voice }: { voice: MomoVoiceControl }) {
  const { t } = useTranslation();
  const styles = useStyles();
  return (
    <View style={{ paddingHorizontal: 16, gap: 8 }}>
      {voice.waiting && <Text style={styles.muted}>{t('momoVoice.starting')}</Text>}
      <ErrorLine text={voice.error} />
      {voice.denied && <OpenSettings />}
    </View>
  );
}
