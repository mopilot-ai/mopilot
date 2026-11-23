// A note on a diff line: the saved note under its line, and the field that writes, changes or removes one.
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { MOST_NOTES, NOTE_CHARS } from '../remote/review';
import { useTheme } from '../theme';
import { Button, ErrorLine, Field } from './ui';
import { typo } from '../typography';

/** The note as saved; a tap changes it. */
export function NoteCard({ text, edit }: { text: string; edit: () => void }) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={`Note: ${text}`}
      accessibilityHint="Change this note"
      onPress={edit}
      style={{ backgroundColor: theme.infoSoft, paddingHorizontal: 10, paddingVertical: 6 }}
    >
      <Text style={{ ...typo.footnote, color: theme.info }}>{text}</Text>
    </Tap>
  );
}

/** Writes a note; a full set of notes takes no new one, and an old note can be removed. Keeps what is typed until saved. */
export function NoteField({
  initial,
  full,
  save,
  remove,
  cancel,
}: {
  initial: string;
  full: boolean;
  save: (text: string) => void;
  remove: () => void;
  cancel: () => void;
}) {
  const theme = useTheme();
  const [text, setText] = useState(initial);
  return (
    <View style={{ gap: 8, padding: 10, backgroundColor: theme.sunken }}>
      {full ? (
        <ErrorLine text={`Up to ${MOST_NOTES} notes at once. Send these first.`} />
      ) : (
        <Field multiline autoFocus maxLength={NOTE_CHARS} value={text} onChangeText={setText} placeholder="Note for the agent" />
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {!full && <Button title="Save note" disabled={!text.trim()} onPress={() => save(text)} />}
        <Button secondary title="Cancel" onPress={cancel} />
        {!!initial && <Button secondary quietDanger title="Remove note" onPress={remove} />}
      </View>
    </View>
  );
}
