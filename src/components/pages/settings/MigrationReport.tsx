// Settings → About → Diagnostics → Chat data: what the move of chat data to the v2 files did (counts, chats that failed)
// and the way back to the pre-migration data.
import { ownTable } from '../../../../shared/ownTable.mjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEffectOn } from '../../../lib/effects';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { native, type MigrationReport as Report } from '../../../lib/native';
import { restoreMigration, retryMigration } from '../../../store/chats';
import { toastFailure, useStore } from '../../../store/core';
import { revealPath } from '../../../session/open';
import { errorText } from '../../../lib/ignored';
import { Group } from '../Settings';

const RESULT_TEXT: Record<string, string> = ownTable({
  ok: 'Finished',
  failed: 'Failed. Your chats were left as they were; they are served from the old files',
  restored: 'Restored from the backup. Your chats are served from the old files until you retry',
});
type Counts = NonNullable<Report['report']>['before'];
const COUNT_ROWS: [keyof Counts, string][] = [
  ['chats', 'Chats'],
  ['pinned', 'Pinned'],
  ['unread', 'Unread'],
  ['archived', 'Archived'],
  ['worktree', 'In a worktree'],
  ['accounts', 'With an account'],
  ['accountsPinned', 'Account pinned'],
  ['multiSegment', 'Switched between harnesses'],
];

export function MigrationAdvanced() {
  const tab = useStore((s) => (s.route.name === 'settings' ? s.route.tab : undefined));
  const [open, setOpen] = useState(tab === 'chat-data');
  useEffect(() => {
    if (tab === 'chat-data') setOpen(true);
  }, [tab]);
  return (
    <>
      <div className="settings-links">
        <button className="link-muted" data-testid="advanced-toggle" onClick={() => setOpen((o) => !o)}>
          Chat data {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      </div>
      {open && <MigrationReportGroup />}
    </>
  );
}

function MigrationReportGroup() {
  // a run, retry or restore elsewhere changes the issue: read the report again (the issue is when, not what, to read)
  const issue = useStore((s) => s.migrationIssue);
  const [r, setR] = useState<Report | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // the report could not be read: said so, since no report means no migration ran
  const [readFailed, setReadFailed] = useState<string | null>(null);
  const reads = useRef(0);
  const read = useCallback(() => {
    // only the newest read lands: an older answer arriving late can't replace it
    const n = ++reads.current;
    setReadFailed(null);
    native.chats.migrationReport().then(
      (report) => n === reads.current && setR(report),
      (e: unknown) => n === reads.current && setReadFailed(errorText(e)),
    );
  }, []);
  useEffectOn([issue], () => {
    read();
  });
  /** Retry or restore, then read the report again; each step that fails says which one it was. */
  const run = async (fn: () => Promise<unknown>, failed: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setBusy(false);
      return toastFailure(failed)(e);
    }
    // a read of its own, counted with the others: whichever read started last is the one shown
    const n = ++reads.current;
    try {
      const report = await native.chats.migrationReport();
      if (n === reads.current) setR(report);
    } catch (e) {
      // the step itself went through; only the report shown here is out of date
      if (n === reads.current) toastFailure("Couldn't read the migration report again")(e);
    } finally {
      setBusy(false);
    }
  };
  if (readFailed)
    return (
      <Group title="Chat data" desc="Migration status and recovery.">
        <div className="migration-report" data-testid="migration-report">
          <p data-testid="migration-result" role="alert">
            Couldn't read the migration report: {readFailed}
          </p>
          <div className="migration-actions">
            <button className="btn-pill" onClick={read}>
              Try again
            </button>
          </div>
        </div>
      </Group>
    );
  if (r === undefined) return null;
  const rep = r?.report;
  return (
    <Group title="Chat data" desc="Migration status and recovery.">
      <div className="migration-report" data-testid="migration-report">
        {!r ? (
          <p data-testid="migration-result">No chat-data migration has run on this profile.</p>
        ) : (
          <>
            <p data-testid="migration-result">
              {RESULT_TEXT[r.result] ?? r.result}
              {r.at ? ` · ${new Date(r.at).toLocaleString()}` : ''}
            </p>
            {rep && (
              <table className="compat-table" data-testid="migration-counts">
                <thead>
                  <tr>
                    <th />
                    <th>Before</th>
                    <th>After</th>
                  </tr>
                </thead>
                <tbody>
                  {COUNT_ROWS.map(([k, label]) => (
                    <tr key={k} data-count={k} className={rep.before[k] !== rep.after[k] ? 'mismatch' : ''}>
                      <th scope="row">{label}</th>
                      <td>{rep.before[k]}</td>
                      <td>{rep.after[k]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {rep && rep.failed.length > 0 && (
              <div data-testid="migration-failed">
                <p>Chats that could not be moved ({rep.failed.length}):</p>
                <ul>
                  {rep.failed.map((id) => (
                    <li key={id} className="mono">
                      {id}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="migration-actions">
              {r.result !== 'ok' && (
                <button className="btn-pill" disabled={busy} onClick={() => run(retryMigration, "Couldn't migrate again")}>
                  Retry
                </button>
              )}
              {r.result !== 'restored' && (
                <button
                  className="btn-pill"
                  disabled={busy || !r.backupOk}
                  title={r.backupOk ? undefined : 'The backup is missing or does not verify'}
                  onClick={() => {
                    if (
                      !confirm(
                        'Restore the data from before the migration? Pins, archive and switched chats go back to what the backup holds; changes made since are lost.',
                      )
                    )
                      return;
                    // cannot reject: run says why the restore failed
                    void run(restoreMigration, "Couldn't restore the pre-migration data");
                  }}
                >
                  Restore pre-migration data
                </button>
              )}
              {r.backup && (
                <button className="link-muted" onClick={() => revealPath(r.backup!)}>
                  Show backup
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Group>
  );
}
