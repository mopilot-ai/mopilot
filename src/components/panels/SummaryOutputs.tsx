// The session rail's Outputs section, as Claude Desktop's: the pages this chat published and the files it wrote outside its
// checkout or that git ignores there (any other file in the repository is Changes'), five before "Show more", each opening
// where the pane opens it.
import { useEffect, useMemo, useState } from 'react';
import { noteIgnored } from '../../lib/ignored';
import { native } from '../../lib/native';
import { useChatMachine } from '../../lib/chatMachine';
import { isUnder, relPath } from '../../lib/paths';
import { sessionOutputPages, sessionOutputs } from '../../lib/sessionOutputs';
import { useStore } from '../../store/core';
import { openOutputFile } from '../../store/outputs/pane';
import { openPaneTab } from '../../store/panes';
import type { TurnState } from '../../store/types';
import { FileText, Globe } from '../ui/icons';
import { RailSection } from './RailSection';

/** Rows shown before "Show more". */
const OUTPUTS_SHOWN = 5;
const NONE: TurnState[] = [];

/**
 * `checkout`: the chat's repository root, whose files the Changes section lists; null without one; undefined while git has not
 * said yet, when only pages show.
 */
export function SummaryOutputs({ threadId, checkout }: { threadId: string; checkout: string | null | undefined }) {
  const turns = useStore((s) => s.runtime[threadId]?.turns ?? NONE);
  const cwd = useStore((s) => s.threads[threadId]?.cwd ?? '');
  const { machine } = useChatMachine(threadId);
  // files on a machine that is offline can't be opened; its pages still can
  const away = !!machine?.away;
  // the folder the chat works in counts as the checkout too: git names a symlinked one by its real path
  const inRepo = (path: string) => !!checkout && (isUnder(path, checkout) || isUnder(path, cwd));
  const written = useMemo(() => (away || checkout === undefined ? [] : sessionOutputs(turns, cwd)), [turns, cwd, away, checkout]);
  // the effect below asks git only when this list (as a key) changes
  const repoPaths = written.filter((f) => inRepo(f.path)).map((f) => f.path);
  // a file git ignores is in no branch diff, so it is an output (coverage/, out/): asked of this Mac's git, a chat here only
  const [ignored, setIgnored] = useState<{ key: string; paths: ReadonlySet<string> }>({ key: '', paths: new Set() });
  const askKey = checkout && !machine && repoPaths.length ? JSON.stringify([checkout, repoPaths]) : '';
  useEffect(() => {
    if (!askKey) return;
    const [root, paths] = JSON.parse(askKey) as [string, string[]];
    let current = true;
    native.git.run(root, ['check-ignore', '--', ...paths]).then(
      // it echoes each ignored path as it was given, and exits 1 when there are none; anything else says nothing is known
      (r) => current && setIgnored({ key: askKey, paths: new Set(r?.ok ? r.stdout.split('\n').filter(Boolean) : []) }),
      (error) => noteIgnored("ask git which of a chat's written files it ignores", error),
    );
    return () => {
      current = false;
    };
  }, [askKey]);
  const ignoredNow = ignored.key === askKey ? ignored.paths : new Set<string>();
  const files = written.filter((f) => !inRepo(f.path) || ignoredNow.has(f.path));
  const pages = useMemo(() => sessionOutputPages(turns), [turns]);
  const [all, setAll] = useState(false);
  const rows = [
    ...pages.map((page) => ({
      key: `published ${page.canonical}`,
      label: `${page.title ?? 'Artifact'}${page.version ? ` · v${page.version}` : ''}`,
      title: page.url,
      kind: 'Page',
      open: () => openPaneTab('browser', { url: page.url, ownerChat: threadId, title: page.title ?? 'Artifact' }),
    })),
    ...files.map((file) => ({
      key: `written ${file.path}`,
      label: relPath(file.path, cwd),
      title: file.path,
      kind: 'File',
      open: () => void openOutputFile(threadId, file.path),
    })),
  ];
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, OUTPUTS_SHOWN);
  return (
    <RailSection chatId={threadId} id="outputs" className="summary-outputs" summary={rows.length}>
      {shown.map((row) => (
        <button key={row.key} type="button" className="summary-row" title={row.title} onClick={row.open}>
          {row.kind === 'Page' ? <Globe size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
          <span className="summary-label">{row.label}</span>
          <span className="summary-hint">{row.kind}</span>
        </button>
      ))}
      {rows.length > OUTPUTS_SHOWN && (
        <button type="button" className="summary-row muted" aria-expanded={all} onClick={() => setAll(!all)}>
          <span className="summary-label">{all ? 'Show less' : 'Show more'}</span>
        </button>
      )}
    </RailSection>
  );
}
