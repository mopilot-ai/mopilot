// Read-only review of a chat's work on the Mac: the changed files by scope, a word-marked diff of one, and a viewer for any file.
import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import type { MobileRuntime } from '../contracts';
import { Button, Card, ErrorLine, useStyles } from '../components/ui';
import { ScreenHeader } from '../components/ChatHeader';
import { Segmented } from '../components/Segmented';
import { monoFamily } from '../fonts';
import { useTheme } from '../theme';
import { Loadable } from '../components/Loadable';
import { Followed } from '../components/Followed';
import { DiffView } from '../components/DiffView';
import { FileView } from '../components/FileView';
import { capabilities, type Capabilities } from '../remote/client';
import { useOwnedRequest } from '../remote/useOwnedRequest';
import { useReviewEvents } from '../remote/useReviewEvents';
import { keepNotes, keptNotes, listChanges, notesMessage, type Change, type Changes, type Note, type Scope } from '../remote/review';
import { useHardwareBack } from '../useHardwareBack';
import { typo } from '../typography';

/** `at`: the change count when the page was loaded, to tell when the Mac has changed it since. */
type Page = { kind: 'list' } | { kind: 'diff'; change: Change; at: number } | { kind: 'file'; path: string; at: number };

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'uncommitted', label: 'Uncommitted' },
  { id: 'branch', label: 'Branch' },
  { id: 'turn', label: 'Last turn' },
];
type Target = { kind: 'diff'; change: Change } | { kind: 'file'; path: string };

const counts = (c: Change) => [c.added ? `+${c.added}` : '', c.removed ? `−${c.removed}` : ''].filter(Boolean).join(' ');

/** A path as a name and the folder it is in. */
const split = (path: string) => {
  const slash = path.lastIndexOf('/');
  return { name: path.slice(slash + 1), dir: slash < 0 ? '' : path.slice(0, slash + 1) };
};

function Counts({ change }: { change: Change }) {
  const theme = useTheme();
  const mono = { fontFamily: monoFamily(), ...typo.caption } as const;
  return (
    <Text style={mono}>
      {!!change.added && <Text style={{ color: theme.ok }}>{`+${change.added}`}</Text>}
      {!!change.added && !!change.removed && ' '}
      {!!change.removed && <Text style={{ color: theme.bad }}>{`−${change.removed}`}</Text>}
    </Text>
  );
}

function List({ changes, open }: { changes: Changes; open: (target: Target) => void }) {
  const styles = useStyles();
  const theme = useTheme();
  if (!changes.files.length)
    return <Text style={styles.muted}>No changes here yet. Files this chat edits on your computer appear here.</Text>;
  return (
    <>
      <View>
        {changes.files.map((c, i) => {
          const { name, dir } = split(c.path);
          const status = c.status !== 'modified' ? c.status : c.binary ? 'binary' : '';
          return (
            <Tap
              key={c.path}
              accessibilityRole="button"
              accessibilityLabel={`View diff ${c.path}`}
              accessibilityValue={{
                text: [c.status, c.binary && c.status !== 'binary' ? 'binary' : '', c.oldPath ? `from ${c.oldPath}` : '', counts(c)]
                  .filter(Boolean)
                  .join(', '),
              }}
              onPress={() => open({ kind: 'diff', change: c })}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                minHeight: 52,
                paddingVertical: 6,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: theme.line,
              }}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ ...typo.subheadSemibold, color: theme.ink }}>
                  {name}
                </Text>
                <Text numberOfLines={1} ellipsizeMode="head" style={{ ...typo.caption, color: theme.ink3 }}>
                  {dir || ' '}
                </Text>
                {!!c.oldPath && (
                  <Text numberOfLines={1} ellipsizeMode="head" style={{ ...typo.caption, color: theme.ink3 }}>
                    {`from ${c.oldPath}`}
                  </Text>
                )}
              </View>
              {!!status && <Text style={{ ...typo.caption, color: theme.ink3 }}>{status}</Text>}
              <Counts change={c} />
              <Text style={{ color: theme.ink3 }}>›</Text>
            </Tap>
          );
        })}
      </View>
      {(changes.truncated || changes.omitted > 0) && (
        <Text style={styles.muted}>
          Showing {changes.files.length} of {changes.total + changes.omitted} changed files. See the rest on your computer.
        </Text>
      )}
    </>
  );
}

export function Review({
  runtime,
  chatId,
  back,
  title,
  subtitle,
}: {
  runtime: MobileRuntime;
  chatId: string;
  back: () => void;
  /** The chat's title and where it runs, for the bar. */
  title?: string;
  subtitle?: string;
}) {
  const styles = useStyles();
  const request = useOwnedRequest(runtime);
  const [page, setPage] = useState<Page>({ kind: 'list' });
  // a diff or file goes back to the changes list, as its own Back does; the list itself goes back to the chat through its header
  useHardwareBack(() => setPage({ kind: 'list' }), page.kind !== 'list');
  const [scope, setScope] = useState<Scope>('uncommitted');
  const version = useReviewEvents(runtime, chatId);
  // the Mac's method list is asked once per screen; a Mac that does not answer is treated as unknown and requests are tried
  const caps = useMemo<Promise<Capabilities | null>>(() => capabilities(request).catch(() => null), [request]);
  const theme = useTheme();
  // notes on diff lines wait here, and in memory, until sent as one message
  const [held, setHeld] = useState({ chatId, notes: keptNotes(runtime, chatId) });
  const notes = held.chatId === chatId ? held.notes : keptNotes(runtime, chatId);
  const [sendError, setSendError] = useState<string | null>(null);
  // a note being written is not among the notes yet, so Send waits for it; Discard asks twice
  const [drafting, setDrafting] = useState(false);
  const [sure, setSure] = useState(false);
  const changeNotes = (next: Note[]) => {
    keepNotes(runtime, chatId, next);
    setHeld({ chatId, notes: next });
    setSendError(null);
    setSure(false);
  };
  function sendNotes() {
    try {
      runtime.send(chatId, notesMessage(notes));
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : String(e));
      return;
    }
    changeNotes([]);
    // the message is in the chat's queue: go where it shows
    back();
  }
  const file = page.kind === 'diff' ? split(page.change.path) : page.kind === 'file' ? split(page.path) : null;
  return (
    <View style={styles.page}>
      {page.kind === 'list' ? (
        <ScreenHeader title="Changes" subtitle={title ?? subtitle} back={back} />
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingHorizontal: 8 }}>
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Back to changes"
            onPress={() => setPage({ kind: 'list' })}
            style={{ minWidth: 88, minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={{ ...typo.calloutMedium, color: theme.ink }}>‹ Changes</Text>
          </Tap>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text accessibilityRole="header" numberOfLines={1} style={{ ...typo.subheadSemibold, color: theme.ink }}>
              {file?.name}
            </Text>
            {!!file?.dir && (
              <Text numberOfLines={1} style={{ ...typo.caption, color: theme.ink3 }}>
                {file.dir}
              </Text>
            )}
          </View>
          {page.kind === 'diff' && page.change.status !== 'deleted' && !page.change.binary ? (
            <Tap
              accessibilityRole="button"
              accessibilityLabel="Open file"
              onPress={() => setPage({ kind: 'file', path: page.change.path, at: version })}
              style={{ minWidth: 88, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}
            >
              <Text style={{ ...typo.calloutMedium, color: theme.ink }}>File</Text>
            </Tap>
          ) : (
            <View style={{ minWidth: 88 }} />
          )}
        </View>
      )}
      <ScrollView contentContainerStyle={[styles.body, { padding: 16, gap: 10 }]}>
        <Followed runtime={runtime} chatId={chatId}>
          {page.kind === 'list' && (
            <>
              <Segmented items={SCOPES.map((s) => ({ key: s.id, label: s.label, onPress: () => setScope(s.id) }))} selected={scope} />
              <Loadable key={`${scope}:${version}`} what="changes" load={async () => listChanges(request, chatId, scope, await caps)}>
                {(changes) => <List changes={changes} open={(target) => setPage({ ...target, at: version })} />}
              </Loadable>
            </>
          )}
          {page.kind !== 'list' && page.at !== version && (
            <Card>
              <Text style={styles.muted}>This changed on your computer.</Text>
              <Button secondary title="Reload" onPress={() => setPage({ ...page, at: version })} />
            </Card>
          )}
          {page.kind === 'diff' && (
            <DiffView
              key={page.at}
              request={request}
              chatId={chatId}
              change={page.change}
              scope={scope}
              caps={caps}
              open={() => setPage({ kind: 'file', path: page.change.path, at: version })}
              notes={notes}
              onNotes={changeNotes}
              onDrafting={setDrafting}
            />
          )}
          {page.kind === 'file' && <FileView key={page.at} request={request} chatId={chatId} path={page.path} caps={caps} />}
        </Followed>
      </ScrollView>
      {!!notes.length && (
        <View style={{ gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: theme.line, backgroundColor: theme.surface }}>
          <ErrorLine text={sendError} />
          {drafting && <Text style={styles.muted}>Save or cancel the open note first.</Text>}
          <Button
            title={`Send ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} to this chat`}
            disabled={drafting}
            onPress={sendNotes}
          />
          <Button
            secondary
            title={sure ? 'Tap again to discard' : 'Discard notes'}
            onPress={() => (sure ? changeNotes([]) : setSure(true))}
          />
        </View>
      )}
    </View>
  );
}
