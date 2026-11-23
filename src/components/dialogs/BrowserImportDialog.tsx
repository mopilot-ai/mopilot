// The "Import from your browser" dialog, laid out as Codex's: pick the browser profile, switch on what to bring (saved passwords, cookies, browsing history, bookmarks), Import; each row then shows its progress and result in place, and Retry runs the ones that failed.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { native, type ImportKind, type ImportKindResult, type ImportSource } from '../../lib/native';
import { setPrefs } from '../../store/core';
import { noteIgnored } from '../../lib/ignored';
import { IMPORT_EVENT, importErrorText } from '../../lib/browserImport';
import { staleGrantHint } from '../../../shared/staleGrant.mjs';
import { X, KeyRound, Cookie, History, Bookmark, Check, CircleAlert, LoaderCircle, FileText } from '../ui/icons';
import { imeComposing } from '../../lib/focus';
import { pluralize } from '../../lib/format';

/** The rows, in Codex's order (it has extensions where we have bookmarks). */
const ROWS: { kind: ImportKind; label: string; icon: ReactNode; importing: string; noun: string }[] = [
  { kind: 'passwords', label: 'Saved passwords', icon: <KeyRound size={16} />, importing: 'Importing saved passwords…', noun: 'password' },
  { kind: 'cookies', label: 'Cookies', icon: <Cookie size={16} />, importing: 'Importing cookies…', noun: 'cookie' },
  { kind: 'history', label: 'Browsing history', icon: <History size={16} />, importing: 'Importing browsing history…', noun: 'page' },
  { kind: 'bookmarks', label: 'Bookmarks', icon: <Bookmark size={16} />, importing: 'Importing bookmarks…', noun: 'bookmark' },
];
/** The order main runs the categories in (importer.cjs KINDS), for "Importing …" while one runs. */
const RUN_ORDER: ImportKind[] = ['bookmarks', 'history', 'cookies', 'passwords'];
type Phase = 'choose' | 'running' | 'done';
type Kinds = Record<ImportKind, boolean>;
type Results = Partial<Record<ImportKind, ImportKindResult>>;

/** A browser profile the picker offers: "<browser>" or "<browser> · <profile>". */
interface Choice {
  key: string;
  source: ImportSource;
  profile: string;
  label: string;
}

/** Every profile of every browser that can be read, or could be with Full Disk Access. */
function choicesOf(sources: ImportSource[]): Choice[] {
  return sources
    .filter((s) => s.status === 'ready' || s.status === 'needs_full_disk_access')
    .flatMap((s) =>
      s.profiles.map((p) => ({
        key: `${s.id}/${p.id}`,
        source: s,
        profile: p.id,
        label: s.profiles.length > 1 || p.name !== s.name ? `${s.name} · ${p.name}` : s.name,
      })),
    );
}

/** What a category brought, in a few words. */
function summary(row: (typeof ROWS)[number], r: ImportKindResult): string {
  const n = r.imported ?? 0;
  const extra = [
    r.skippedExisting ? `${r.skippedExisting} already here` : '',
    r.replaced ? `${r.replaced} updated` : '',
    r.failed ? `${r.failed} refused` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return `${pluralize(n, row.noun)}${extra ? ` (${extra})` : ''}`;
}

export function BrowserImportDialog() {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [choiceKey, setChoiceKey] = useState('');
  const [kinds, setKinds] = useState<Kinds>({ bookmarks: true, history: true, cookies: true, passwords: true });
  const [phase, setPhase] = useState<Phase>('choose');
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Results>({});
  /** the categories the running (or last) import asked for */
  const [asked, setAsked] = useState<ImportKind[]>([]);
  /** the running job's id, and which request the dialog waits on (a later one, or closing, makes an earlier answer stale) */
  const job = useRef<string | null>(null);
  const request = useRef(0);
  /** a step is in flight: a second click while it waits must not start another */
  const pending = useRef(false);
  /** the browser being imported from, named in the errors that outlive its selection */
  const browserName = useRef('the browser');
  /** the passwords file the user chose (Safari's export; main keeps its path), and whether it went to the Trash */
  const [file, setFile] = useState<{ name: string; trashed?: boolean } | null>(null);
  /** "Check again" found the browser still blocked: the switch may be on for an older copy of the app */
  const [rechecked, setRechecked] = useState(false);

  const choices = sources ? choicesOf(sources) : [];
  const choice = choices.find((c) => c.key === choiceKey) ?? null;
  const supported = (k: ImportKind) => !!choice?.source.kinds[k];
  const fromFile = !!choice?.source.passwordFile;
  /** what can be imported now: everything when the browser's files can be read; a passwords file needs no access to them */
  const usable = (k: ImportKind) =>
    supported(k) &&
    (choice?.source.status === 'ready' || (k === 'passwords' && fromFile && choice?.source.status === 'needs_full_disk_access'));

  const choose = useCallback((c: Choice | undefined) => {
    setChoiceKey(c?.key ?? '');
    setFile(null);
    setKinds({
      bookmarks: !!c?.source.kinds.bookmarks,
      history: !!c?.source.kinds.history,
      cookies: !!c?.source.kinds.cookies,
      // passwords from a file the user first exports: off until they turn it on
      passwords: !!c?.source.kinds.passwords && !c?.source.passwordFile,
    });
  }, []);

  const load = useCallback(
    async (wanted?: string | null, recheck = false) => {
      const mine = ++request.current;
      const list = await native.browser.import.sources().catch((e) => {
        noteIgnored('list the browsers to import from', e);
        return [] as ImportSource[];
      });
      if (request.current !== mine) return;
      setRechecked(recheck);
      setSources(list);
      const all = choicesOf(list);
      choose(all.find((c) => c.key === wanted || c.source.id === wanted) ?? all.find((c) => c.source.status === 'ready') ?? all[0]);
    },
    [choose],
  );

  useEffect(() => {
    const onOpen = (e: Event) => {
      job.current = null;
      pending.current = false;
      setSources(null);
      setPhase('choose');
      setError(null);
      setResults({});
      setAsked([]);
      setOpen(true);
      void load((e as CustomEvent).detail);
    };
    window.addEventListener(IMPORT_EVENT, onOpen);
    return () => window.removeEventListener(IMPORT_EVENT, onOpen);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    return native.browser.import.onProgress((e) => {
      if (e.jobId === job.current) setResults((r) => ({ ...r, [e.kind]: e.result }));
    });
  }, [open]);

  const close = useCallback(() => {
    request.current++;
    pending.current = false;
    const id = job.current;
    job.current = null;
    if (id) native.browser.import.cancel(id).catch((e) => noteIgnored('cancel a browser import', e));
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !imeComposing(e) && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  /** Prepares the import (the Mac asks for the browser's key) and runs it, for every site, as Codex does. */
  const begin = useCallback(
    async (wanted: ImportKind[], keep: Results) => {
      if (!choice || pending.current) return;
      pending.current = true;
      browserName.current = choice.source.name;
      const mine = ++request.current;
      setError(null);
      setResults(keep);
      setAsked(wanted);
      setPhase('running');
      try {
        const kindsReq = Object.fromEntries(RUN_ORDER.map((k) => [k, wanted.includes(k)])) as Kinds;
        const started = await native.browser.import.start({ source: choice.source.id, profile: choice.profile, kinds: kindsReq });
        if (request.current !== mine) {
          if (started.ok) native.browser.import.cancel(started.jobId).catch((e) => noteIgnored('cancel a browser import', e));
          return;
        }
        if (!started.ok) {
          setError(importErrorText(started.code, browserName.current));
          setPhase('choose');
          return;
        }
        job.current = started.jobId;
        const out = await native.browser.import.run({ jobId: started.jobId, sites: started.sites.map((s) => s.site) });
        if (request.current !== mine) return;
        job.current = null;
        if (!out.ok) {
          setError(importErrorText(out.code, browserName.current));
          setPhase('choose');
          return;
        }
        const all = { ...keep, ...out.results };
        setResults(all);
        setPhase('done');
        if (Object.values(all).some((r) => r?.status === 'ok' && (r.imported ?? 0) > 0)) setPrefs({ browserImportPrompt: 'done' });
      } finally {
        pending.current = false;
      }
    },
    [choice],
  );

  if (!open) return null;
  const shown = ROWS.filter((r) => !choice || usable(r.kind));
  const chosen = shown.filter((r) => kinds[r.kind]).map((r) => r.kind);
  const needsFile = fromFile && chosen.includes('passwords') && !file;
  const chooseFile = async () => {
    const picked = await native.browser.import.choosePasswordFile().catch((e) => {
      noteIgnored('choose a passwords file', e);
      return null;
    });
    if (picked) setFile(picked);
  };
  const trashFile = async () => {
    const r = await native.browser.import.trashPasswordFile().catch(() => ({ ok: false as const, code: 'read_failed', message: '' }));
    if (r.ok) setFile((f) => f && { ...f, trashed: true });
    else setError("Couldn't move the passwords file to the Trash. Delete it in Finder.");
  };
  const failed = asked.filter((k) => results[k]?.status === 'failed' || results[k]?.status === 'cancelled');
  // what has come in so far, this run or one a Retry follows
  const ok = RUN_ORDER.filter((k) => results[k]?.status === 'ok');
  const imported = ok.some((k) => (results[k]?.imported ?? 0) > 0);
  const current = RUN_ORDER.find((k) => asked.includes(k) && !results[k]);
  const secret =
    choice?.source.kind === 'chromium' && ((kinds.cookies && supported('cookies')) || (kinds.passwords && supported('passwords')));
  const title = phase === 'done' ? (ok.length ? 'Import complete' : 'Import failed') : 'Import from your browser';
  const subtitle =
    phase === 'running'
      ? (ROWS.find((r) => r.kind === current)?.importing ?? 'Importing…')
      : phase === 'done'
        ? !ok.length
          ? 'We were unable to import your browsing data'
          : imported
            ? 'Your data is now available in the built-in browser'
            : 'No browser data was available to import'
        : 'Choose data to bring over to the built-in browser';

  /** A row's right side: the switch while choosing, then its progress and result. */
  const status = (row: (typeof ROWS)[number]) => {
    // a row this import (or the one a Retry follows) did not touch keeps its switch
    if (phase === 'choose' || (!asked.includes(row.kind) && !results[row.kind])) {
      const on = kinds[row.kind];
      return (
        <button
          className={`toggle ${on ? 'on' : ''}`}
          role="switch"
          aria-checked={on}
          aria-label={row.label}
          disabled={phase !== 'choose'}
          onClick={() => setKinds({ ...kinds, [row.kind]: !on })}
        >
          <span className="toggle-knob" />
        </button>
      );
    }
    const r = results[row.kind];
    if (!r) return <LoaderCircle size={16} className="import-spin" aria-label="Importing" />;
    if (r.status === 'ok')
      return (
        <span className="import-result">
          {summary(row, r)} <Check size={14} aria-label="Done" />
        </span>
      );
    return (
      <span className="import-result failed">
        {r.status === 'cancelled' ? 'Cancelled' : 'Failed'} <CircleAlert size={14} aria-label="Failed" />
      </span>
    );
  };

  return (
    <div className="sketch-backdrop" onMouseDown={(e) => e.target === e.currentTarget && phase !== 'running' && close()}>
      <div className="dialog import-dialog" role="dialog" aria-labelledby="import-title">
        <div className="dialog-head">
          <span id="import-title">{title}</span>
          <button className="icon-btn xs" onClick={close} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <p className="import-subtitle">{subtitle}</p>

        <label className="import-from">
          <span>From</span>
          {sources === null ? (
            <span className="import-muted">Loading profiles…</span>
          ) : !choices.length ? (
            <span className="import-muted">No browsers to import from were found on this Mac</span>
          ) : (
            <select
              aria-label="From"
              value={choiceKey}
              disabled={phase !== 'choose'}
              onChange={(e) => choose(choices.find((c) => c.key === e.target.value))}
            >
              {choices.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                  {c.source.status === 'needs_full_disk_access' ? ' (needs Full Disk Access)' : ''}
                </option>
              ))}
            </select>
          )}
        </label>

        {choice?.source.status === 'needs_full_disk_access' ? (
          <div className="import-note" role="status">
            <span>
              {choice.source.name}'s files are protected. Allow MoPilot in System Settings → Privacy &amp; Security → Full Disk Access, then
              check again.
              {rechecked && ` ${staleGrantHint('MoPilot', 'Full Disk Access')}`}
            </span>
            <div className="import-note-actions">
              <button
                className="btn sm"
                onClick={() => native.browser.import.openFullDiskAccess().catch((e) => noteIgnored('open Full Disk Access settings', e))}
              >
                Open Settings
              </button>
              <button className="btn sm" onClick={() => void load(choiceKey, true)}>
                Check again
              </button>
            </div>
          </div>
        ) : (
          choice && phase === 'choose' && <p className="import-muted">Close {choice.source.name} completely before importing</p>
        )}

        {shown.length > 0 && choice && (
          <div className="import-rows">
            {shown.map((row) => {
              const r = results[row.kind];
              return (
                <div key={row.kind} className="import-row" data-state={asked.includes(row.kind) ? (r?.status ?? 'running') : 'off'}>
                  <span className="import-row-icon">{row.icon}</span>
                  <span className="import-name">{row.label}</span>
                  {status(row)}
                  {r && r.status !== 'ok' && phase === 'done' && (
                    <p className="import-error" role="alert">
                      {r.status === 'cancelled'
                        ? 'The import was cancelled.'
                        : importErrorText(r.code ?? 'read_failed', browserName.current, row.kind, fromFile && row.kind === 'passwords')}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {fromFile &&
          ((phase === 'choose' && kinds.passwords && shown.some((r) => r.kind === 'passwords')) ||
            // a file that failed: choose another before Retry
            (phase === 'done' && failed.includes('passwords'))) && (
            <div className="import-note" role="status">
              <span>
                {choice?.source.name} keeps passwords in iCloud Keychain, which other apps can't read. In {choice?.source.name}, choose File
                → Export → Passwords…, then choose that file here.
              </span>
              <div className="import-note-actions">
                <button className="btn sm" onClick={() => void chooseFile()}>
                  {file ? 'Choose another file…' : 'Choose file…'}
                </button>
                {file && (
                  <span className="import-file">
                    <FileText size={14} /> {file.name}
                  </span>
                )}
              </div>
            </div>
          )}
        {fromFile && phase === 'done' && results.passwords?.status === 'ok' && file && (
          <div className="import-note" role="status">
            {file.trashed ? (
              <span>{file.name} is in the Trash. Empty the Trash to remove it for good.</span>
            ) : (
              <>
                <span>{file.name} still holds your passwords in plain text. Move it to the Trash now that they are imported.</span>
                <div className="import-note-actions">
                  <button className="btn sm" onClick={() => void trashFile()}>
                    Move to Trash
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {phase === 'choose' && secret && (
          <p className="import-muted">
            Your Mac will ask to allow access to "{choice?.source.name} Safe Storage". Passwords stay encrypted in MoPilot and agents never
            see them; sign-ins go to the shared browser profile.
          </p>
        )}
        {error && (
          <p className="import-error" role="alert">
            {error}
          </p>
        )}

        <div className="acct-dialog-actions">
          <span style={{ flex: 1 }} />
          {phase === 'done' ? (
            <>
              {failed.length > 0 && (
                <button className="btn sm" onClick={() => void begin(failed, Object.fromEntries(ok.map((k) => [k, results[k]])))}>
                  Retry
                </button>
              )}
              <button className="btn primary sm" onClick={close}>
                Done
              </button>
            </>
          ) : (
            <>
              <button className="btn sm" onClick={close}>
                Cancel
              </button>
              <button
                className="btn primary sm"
                disabled={phase !== 'choose' || !chosen.length || needsFile}
                onClick={() => void begin(chosen, {})}
              >
                Import
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
