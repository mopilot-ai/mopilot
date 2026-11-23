// A chat's surviving written files remain reachable after navigation or restoring persisted history.
import { useMemo, useState } from 'react';
import { useStore } from '../../store/core';
import { sessionOutputs, sessionOutputPages } from '../../lib/sessionOutputs';
import { openOutputFile } from '../../store/outputs/pane';
import { relPath } from '../../lib/paths';
import { FileText } from '../ui/icons';
import { useChatMachine } from '../../lib/chatMachine';
import { MachineFolderNote } from './MachineFolderNote';
import { openPaneTab } from '../../store/panes';
import { loadOlderTurns } from '../../store/threads';
import { errorText } from '../../lib/ignored';
import { pluralize } from '../../lib/format';

const EMPTY: never[] = [];
export function OutputsPanel({ threadId }: { threadId: string }) {
  return <OutputsContent key={threadId} threadId={threadId} />;
}

function OutputsContent({ threadId }: { threadId: string }) {
  const turns = useStore((s) => s.runtime[threadId]?.turns ?? EMPTY);
  const cwd = useStore((s) => s.threads[threadId]?.cwd ?? '');
  const loading = useStore((s) => !!s.runtime[threadId]?.loading);
  const error = useStore((s) => (s.runtime[threadId]?.errorFromRead ? s.runtime[threadId]?.error : null));
  // a chat on a machine opens its files through the machine's Host, so they are listed while it is reachable and not while it is away
  const { machine } = useChatMachine(threadId);
  const away = !!machine?.away;
  const files = useMemo(() => (away ? [] : sessionOutputs(turns, cwd)), [turns, cwd, away]);
  const pages = useMemo(() => sessionOutputPages(turns), [turns]);
  const older = useStore((s) => !!s.runtime[threadId]?.olderCursor);
  const [more, setMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <section className="session-pane" aria-label="Session outputs">
      <header>
        <h2>Outputs</h2>
        <span>{pluralize(files.length + pages.length, 'output')}</span>
      </header>
      <p>Files and published pages from the loaded conversation. Files open their current version from disk.</p>
      {loading && <p role="status">Loading conversation…</p>}
      {error && <p role="alert">Could not load all outputs: {error}</p>}
      {machine?.away && <MachineFolderNote machine={machine} what="Files" />}
      {!files.length && !pages.length && !loading && !away && <p>No outputs in the loaded part of this conversation.</p>}
      {failure && <p role="alert">{failure}</p>}
      {older && (
        <button
          className="btn-pill"
          disabled={more}
          onClick={() => {
            setMore(true);
            setFailure(null);
            void loadOlderTurns(threadId)
              .catch((e) => setFailure(errorText(e) || 'Could not load earlier outputs'))
              .finally(() => setMore(false));
          }}
        >
          {more ? 'Loading earlier outputs…' : 'Load earlier outputs'}
        </button>
      )}
      <div className="session-output-list">
        {pages.map((page) => (
          <button
            key={page.canonical}
            className="session-output"
            title={page.url}
            onClick={() => openPaneTab('browser', { url: page.url, ownerChat: threadId, title: page.title ?? 'Artifact' })}
          >
            <FileText size={16} />
            <span>
              {page.title ?? 'Artifact'}
              {page.version ? ` · v${page.version}` : ''}
            </span>
          </button>
        ))}
        {files.map((file) => (
          <button key={file.path} className="session-output" title={file.path} onClick={() => void openOutputFile(threadId, file.path)}>
            <FileText size={16} />
            <span>{relPath(file.path, cwd)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
