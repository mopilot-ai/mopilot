// Records a voice note, has the Mac transcribe it, and hands the transcript back for editing before anything is sent.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { Media } from '../platform/media';
import type { Capabilities, Owned } from '../remote/client';
import { useVoiceNote } from '../remote/useVoiceNote';
import { OpenSettings } from './OpenSettings';
import { Button, ErrorLine, Field, useStyles } from './ui';
import { Waveform } from './Waveform';

export function VoiceNote({
  media,
  request,
  caps,
  use,
  onBusy,
}: {
  media: Media;
  request: Owned;
  caps: Capabilities | null;
  use: (text: string) => void;
  /** Told whether a recording, a transcription or a transcript to edit is under way, so a menu holding this stays open. */
  onBusy?: (busy: boolean) => void;
}) {
  const styles = useStyles();
  const [transcript, setTranscript] = useState<string | null>(null);
  const voice = useVoiceNote({ media, request, caps, onText: setTranscript });
  const { phase, error, denied, waiting } = voice;
  const busy = phase !== 'idle' || transcript !== null;
  useEffect(() => onBusy?.(busy), [busy, onBusy]);
  return (
    <View style={{ gap: 8 }}>
      {phase === 'idle' && transcript === null && (
        <Button
          secondary
          title="Record voice note"
          disabled={waiting}
          onPress={() => {
            void voice.start();
          }}
        />
      )}
      {phase === 'recording' && <Waveform meter={voice.meter} />}
      {phase === 'recording' && (
        <View style={styles.row}>
          <Button
            title="Stop and transcribe"
            onPress={() => {
              void voice.stop();
            }}
          />
          <Button
            secondary
            title="Cancel recording"
            onPress={() => {
              void voice.discard();
            }}
          />
        </View>
      )}
      {phase === 'transcribing' && (
        <View style={styles.row}>
          <Text style={styles.muted}>Your computer is transcribing…</Text>
          <Button secondary title="Cancel transcription" onPress={voice.cancelTranscribing} />
        </View>
      )}
      {waiting && <Text style={styles.muted}>Starting… answer the microphone prompt if iOS asks.</Text>}
      <ErrorLine text={error} />
      {denied && <OpenSettings />}
      {transcript !== null && (
        <View style={{ gap: 8 }}>
          <Text style={styles.muted}>Edit the transcript, then use it. Nothing is sent yet.</Text>
          <Field multiline placeholder="Transcript" value={transcript} onChangeText={setTranscript} />
          <View style={styles.row}>
            <Button
              title="Use text"
              disabled={!transcript.trim()}
              onPress={() => {
                use(transcript.trim());
                setTranscript(null);
              }}
            />
            <Button secondary title="Discard" onPress={() => setTranscript(null)} />
          </View>
        </View>
      )}
    </View>
  );
}
