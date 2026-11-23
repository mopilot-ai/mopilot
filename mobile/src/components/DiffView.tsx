// One file's diff, a page of rows at a time, with the changed words of paired lines emphasized from the Mac's word spans, and a tap on a line to leave a note (the diff itself stays read-only).
import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import type { Capabilities, Owned } from '../remote/client';
import { usePaged } from '../remote/usePaged';
import {
  lineNote,
  MOST_NOTES,
  readDiff,
  sameLine,
  setNote,
  type Change,
  type DiffPage,
  type Note,
  type Row,
  type Scope,
} from '../remote/review';
import { NoteCard, NoteField } from './LineNote';
import { Button, ErrorLine, useStyles } from './ui';
import { numberRows } from '../presentation/diffLines';
import { monoFamily } from '../fonts';
import { useTheme } from '../theme';
import { Loadable } from './Loadable';
import { typo, typoWeight } from '../typography';

/** The row's text split at its changed span. */
const parts = (row: Row) =>
  row.w
    ? [
        { key: 0, text: row.t.slice(0, row.w[0]), changed: false },
        { key: 1, text: row.t.slice(row.w[0], row.w[1]), changed: true },
        { key: 2, text: row.t.slice(row.w[1]), changed: false },
      ]
    : [{ key: 0, text: row.t, changed: false }];

type Noteable = Row & { k: 'add' | 'del' | 'ctx' };
const noteable = (row: Row): row is Noteable => row.k === 'add' || row.k === 'del' || row.k === 'ctx';

/** One added, removed or context line; it takes a tap (to leave a note) when its line number is known. */
const Line = memo(function Line({
  row,
  line,
  gutter,
  open,
}: {
  row: Row;
  line: number | null;
  gutter: number;
  open?: (id: number) => void;
}) {
  const theme = useTheme();
  const mono = { fontFamily: monoFamily(), ...typo.caption } as const;
  const add = row.k === 'add';
  const del = row.k === 'del';
  const style = { flexDirection: 'row', backgroundColor: add ? theme.addBg : del ? theme.delBg : undefined } as const;
  const label =
    add || del
      ? `${add ? 'Added' : 'Removed'}${line === null ? '' : `, line ${line}`}: ${row.t}${row.cut ? ' (line cut)' : ''}`
      : undefined;
  const body = (
    <>
      <Text numberOfLines={1} style={{ ...mono, minWidth: gutter, textAlign: 'right', paddingRight: 6, color: theme.ink2 }}>
        {line ?? ''}
      </Text>
      {/* the sign says added or removed as well as the tint */}
      <Text style={{ ...mono, minWidth: 14, fontWeight: typoWeight.bold, color: add ? theme.ok : theme.bad }}>
        {add ? '+' : del ? '−' : ''}
      </Text>
      <Text selectable style={{ ...mono, flex: 1, color: theme.ink, paddingRight: 8 }}>
        {parts(row).map((s) => (
          <Text
            key={s.key}
            style={s.changed ? { fontWeight: typoWeight.bold, textDecorationLine: del ? 'line-through' : 'underline' } : undefined}
          >
            {s.text}
          </Text>
        ))}
        {row.cut ? ' … (line cut)' : ''}
      </Text>
    </>
  );
  if (!open)
    return (
      <View accessible={add || del} accessibilityLabel={label} style={style}>
        {body}
      </View>
    );
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label ?? `Line ${line}: ${row.t}`}
      accessibilityHint="Add a note"
      onPress={() => open(row.id)}
      style={style}
    >
      {body}
    </Tap>
  );
});

function Rows({
  rows,
  path,
  notes,
  onNotes,
  onDrafting,
}: {
  rows: Row[];
  path: string;
  notes: Note[];
  onNotes: (next: Note[]) => void;
  onDrafting: (open: boolean) => void;
}) {
  const theme = useTheme();
  const numbered = useMemo(() => numberRows(rows), [rows]);
  // the gutter is as wide as the largest number needs, so a long file does not wrap its numbers
  const gutter = useMemo(() => Math.max(3, String(Math.max(0, ...numbered.map((n) => n.line ?? 0))).length) * 8 + 10, [numbered]);
  const [editing, setEditing] = useState<number | null>(null);
  // one field at a time: a tap on another line while a note is being written must not throw the draft away
  const open = useCallback((id: number) => setEditing((now) => now ?? id), []);
  // the screen holds Send back while a note is half written, since an unsaved draft is not among the notes
  useEffect(() => {
    onDrafting(editing !== null);
    return () => onDrafting(false);
  }, [editing, onDrafting]);
  return (
    <View style={{ borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: theme.line }}>
      {numbered.map(({ row, line }) => {
        if (row.k === 'hunk' || row.k === 'meta')
          return (
            <View key={row.id} style={{ backgroundColor: theme.sunken, paddingHorizontal: 10, paddingVertical: 3 }}>
              <Text selectable style={{ fontFamily: monoFamily(), ...typo.caption, color: theme.ink3 }}>
                {row.t}
              </Text>
            </View>
          );
        // a line whose number is not known (a hunk header that did not read) cannot be named to the agent, so it takes no note
        const key = noteable(row) && line !== null ? lineNote(path, row, line, '') : null;
        const note = key ? notes.find((n) => sameLine(n, key)) : undefined;
        return (
          <Fragment key={row.id}>
            <Line row={row} line={line} gutter={gutter} open={key ? open : undefined} />
            {editing === row.id && key && noteable(row) ? (
              <NoteField
                key={row.id}
                initial={note?.text ?? ''}
                full={!note && notes.length >= MOST_NOTES}
                save={(text) => {
                  onNotes(setNote(notes, { ...key, text: lineNote(path, row, key.line, text).text }));
                  setEditing(null);
                }}
                remove={() => {
                  onNotes(setNote(notes, key));
                  setEditing(null);
                }}
                cancel={() => setEditing(null)}
              />
            ) : (
              !!note && <NoteCard text={note.text} edit={() => setEditing(row.id)} />
            )}
          </Fragment>
        );
      })}
    </View>
  );
}

/** Pages are appended as the person asks; a failed page keeps what is shown and offers Retry or a reload from the start. */
function Pages({
  first,
  more,
  open,
  path,
  notes,
  onNotes,
  onDrafting,
}: {
  first: DiffPage;
  more: (from: number) => Promise<DiffPage>;
  open: () => void;
  path: string;
  notes: Note[];
  onNotes: (next: Note[]) => void;
  onDrafting: (open: boolean) => void;
}) {
  const styles = useStyles();
  // a new start gives the rows new ids for what may be other lines: a field open on the old ones goes
  const [run, setRun] = useState(0);
  const paged = usePaged<Row[]>(
    { items: first.rows, next: first.next },
    async (from) => {
      const page = await more(from);
      return { items: page.rows, next: page.next };
    },
    (all, page) => [...all, ...page],
  );
  const { items: rows, next, error, busy } = paged;
  if (first.binary)
    return (
      <>
        <Text style={styles.muted}>This is a binary file, so there is no text diff.</Text>
        <Button secondary title="Open file" onPress={open} />
      </>
    );
  if (!rows.length)
    return (
      <>
        <Text style={styles.muted}>There is no text diff for this file (it may be empty or only renamed).</Text>
        <Button secondary title="Open file" onPress={open} />
      </>
    );
  return (
    <View style={{ gap: 8 }}>
      <Rows key={run} rows={rows} path={path} notes={notes} onNotes={onNotes} onDrafting={onDrafting} />
      <ErrorLine text={error} />
      {next !== null && (
        <Button
          secondary
          title={busy ? 'Loading…' : error ? 'Retry' : `Load more (${rows.length} of ${first.total} rows)`}
          disabled={busy}
          onPress={() => {
            void paged.load();
          }}
        />
      )}
      {error && (
        <Button
          secondary
          title="Start over"
          disabled={busy}
          onPress={() => {
            setRun((n) => n + 1);
            void paged.reload();
          }}
        />
      )}
    </View>
  );
}

export function DiffView({
  request,
  chatId,
  change,
  scope,
  caps,
  open,
  notes,
  onNotes,
  onDrafting,
}: {
  request: Owned;
  chatId: string;
  change: Change;
  scope: Scope;
  caps: Promise<Capabilities | null>;
  open: () => void;
  /** Every note on this chat's diffs, and where they are changed. */
  notes: Note[];
  onNotes: (next: Note[]) => void;
  /** Whether a note is being written, which the screen waits for before sending. */
  onDrafting: (open: boolean) => void;
}) {
  const page = async (from: number) => readDiff(request, chatId, change, scope, from, await caps);
  return (
    <Loadable what="diff" load={() => page(0)}>
      {(first) => (
        <Pages first={first} more={page} open={open} path={change.path} notes={notes} onNotes={onNotes} onDrafting={onDrafting} />
      )}
    </Loadable>
  );
}
