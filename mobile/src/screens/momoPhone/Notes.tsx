// MoMo's Notes tab: the list, a note with the sources behind each line, edit, History with Undo, Forget, empty, and the read-only cached copy while the home sleeps.
import { say } from '../../momoPhone/say';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Group, GroupItem } from '../../components/Grouped';
import { Pill } from '../MomoPill';
import { useTheme } from '../../theme';
import { typo } from '../../typography';
import type { MomoNoteView } from '../../../../shared/momoView';
import type { PhoneView } from '../../momoPhone/types';
import { editNote, historyRows, lineBadge, noteRow, notesState, whyLine } from '../../momoPhone/workModels';
import { ActPill, ButtonRow, Body, Card, Serif, Title, type Act } from './parts';

export function NotesScreen({
  view,
  open,
  connect,
  write,
}: {
  view: PhoneView;
  open: (id: string) => void;
  connect: () => void;
  write: () => void;
}) {
  const st = notesState(view);
  if (st.empty) {
    return (
      <View>
        <Title>{say('notes')}</Title>
        <Body>{st.empty.title}</Body>
        <Body>{st.empty.body}</Body>
        <View style={{ gap: 8, marginTop: 12 }}>
          <Pill strong disabled={false} title={st.empty.actions[0]} onPress={connect} />
          <Pill disabled={false} title={st.empty.actions[1]} onPress={write} />
        </View>
      </View>
    );
  }
  return <NotesList view={view} open={open} />;
}

/** The notes, one row each: their title, the date and where they were learned. */
export function NotesList({ view, open }: { view: PhoneView; open: (id: string) => void }) {
  return (
    <View>
      <Group>
        {view.view.notes.map(noteRow).map((n) => (
          <GroupItem key={n.id} title={n.title} detail={n.detail} end="chevron" onPress={() => open(n.id)} />
        ))}
      </Group>
    </View>
  );
}

export function NoteDetail({ view, note, act }: { view: PhoneView; note: MomoNoteView; act: Act }) {
  const theme = useTheme();
  const readOnly = notesState(view).readOnly;
  const [whyOpen, setWhyOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [history, setHistory] = useState(false);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const entries = historyRows(note);
  if (history) {
    return (
      <View>
        <Title>{say('historyTitle', { title: note.title })}</Title>
        <Group>
          {entries.map((e) => (
            <GroupItem
              key={e.id}
              title={e.what}
              detail={e.when}
              value={e.undoable && !readOnly ? say('undo') : undefined}
              onPress={e.undoable && !readOnly ? () => act({ kind: 'note-undo', noteId: note.id, changeId: e.id }) : undefined}
            />
          ))}
        </Group>
        {!readOnly && <ActPill title={say('restoreLastNight')} intent={{ kind: 'note-restore', noteId: note.id }} act={act} />}
        <Pill disabled={false} title={say('backToNote')} onPress={() => setHistory(false)} />
      </View>
    );
  }
  return (
    <View>
      <Title>{note.title}</Title>
      <Pill disabled={false} title={say('history')} onPress={() => setHistory(true)} />
      {note.lines.map((line) => {
        const why = whyLine(line);
        if (forgetting === line.id)
          return (
            <Card key={line.id}>
              <Title>{say('forgetThisLine')}</Title>
              <Body dim={false}>{line.text}</Body>
              <ButtonRow>
                <ActPill strong title={say('forget')} intent={{ kind: 'note-forget', noteId: note.id, lineId: line.id }} act={act} />
                <Pill disabled={false} title={say('keep')} onPress={() => setForgetting(null)} />
              </ButtonRow>
            </Card>
          );
        return (
          <Card key={line.id}>
            <Text style={{ ...typo.footnote, color: theme.ink2 }}>{lineBadge(line)}</Text>
            {editing === line.id ? (
              <>
                <TextInput
                  accessibilityLabel={say('editLine')}
                  multiline
                  value={text}
                  onChangeText={setText}
                  style={{ ...typo.body, color: theme.ink, backgroundColor: theme.sunken, borderRadius: 14, padding: 10, marginTop: 6 }}
                />
                <Body>{editNote()}</Body>
                <ButtonRow top={8}>
                  <Pill
                    strong
                    disabled={!text.trim()}
                    title={say('save')}
                    onPress={() => {
                      act({ kind: 'note-edit', noteId: note.id, lineId: line.id, text: text.trim() });
                      setEditing(null);
                    }}
                  />
                  <Pill disabled={false} title={say('cancel')} onPress={() => setEditing(null)} />
                </ButtonRow>
              </>
            ) : (
              <Serif>{line.text}</Serif>
            )}
            {why && (
              <>
                <Pill disabled={false} title={say('whyMomoThinksThis')} onPress={() => setWhyOpen(whyOpen === line.id ? null : line.id)} />
                {whyOpen === line.id && (
                  <View>
                    {why.quote && <Body dim={false}>{why.quote}</Body>}
                    {why.from && <Body>{why.from}</Body>}
                    {why.gone && <Body>{why.gone}</Body>}
                    {why.open && <ActPill title={why.open.label} intent={why.open.intent} act={act} />}
                    {why.moreLine && <Body>{why.moreLine}</Body>}
                  </View>
                )}
              </>
            )}
            {editing !== line.id && (
              <ButtonRow top={8}>
                {!readOnly && (
                  <Pill
                    disabled={false}
                    title={say('edit')}
                    onPress={() => {
                      setText(line.text);
                      setEditing(line.id);
                    }}
                  />
                )}
                {!readOnly && <Pill disabled={false} title={say('forget')} onPress={() => setForgetting(line.id)} />}
              </ButtonRow>
            )}
          </Card>
        );
      })}
    </View>
  );
}

/** Write your own note: a title and a line, kept on the home like a learned one. */
export function NewNote({ act, done }: { act: Act; done: () => void }) {
  const theme = useTheme();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  return (
    <View>
      <Title>{say('newNote')}</Title>
      <TextInput
        accessibilityLabel={say('noteTitle')}
        placeholder={say('title')}
        value={title}
        onChangeText={setTitle}
        style={{ ...typo.body, color: theme.ink, backgroundColor: theme.sunken, borderRadius: 14, padding: 10, marginTop: 8 }}
      />
      <TextInput
        accessibilityLabel={say('noteText')}
        placeholder={say('whatShouldMomoKnow')}
        multiline
        value={text}
        onChangeText={setText}
        style={{ ...typo.body, color: theme.ink, backgroundColor: theme.sunken, borderRadius: 14, padding: 10, marginTop: 8 }}
      />
      <ButtonRow>
        <Pill
          strong
          disabled={!title.trim() || !text.trim()}
          title={say('save')}
          onPress={() => {
            act({ kind: 'note-create', title: title.trim(), text: text.trim() });
            done();
          }}
        />
        <Pill disabled={false} title={say('cancel')} onPress={done} />
      </ButtonRow>
    </View>
  );
}
