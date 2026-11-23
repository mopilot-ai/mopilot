// The Files pane of a chat on a machine: the folder's tree and the open file's text, read through the machine's Host (read-only: no search, no editing). Folders are read as they open; the refresh button reads what is shown again.
import { useRef, useState } from 'react';
import { useEffectOn } from '../../../lib/effects';
import { useStore } from '../../../store/core';
import type { ChatMachine } from '../../../lib/chatMachine';
import { fileName, dirname } from '../../../lib/paths';
import { useRemoteFile, useRemoteTree } from '../../../lib/hostFileView';
import { ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw, Spinner } from '../../ui/icons';
import { HostUpdateAction } from '../../host/HostUpdateAction';
import { MachineNotice } from '../MachineFolderNote';
import { LangIcon } from '../DiffPanel';

/** The size a binary file is shown with. */
const sizeOf = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function RemoteFilesPanel({ machine, threadId }: { machine: ChatMachine; threadId: string | null }) {
  // the folder on the machine is the chat's own
  const folder = useStore((s) => (threadId ? (s.threads[threadId]?.cwd ?? '') : ''));
  const [active, setActive] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  return (
    <div className="files-workspace tree-left">
      <div className="files-tree-col">
        <div className="files-tabs">
          <span className="files-tree-title" title={folder}>
            {fileName(folder) || folder}
          </span>
          <button className="cp-tool" aria-label="Read again" title="Read again" onClick={() => setReload((n) => n + 1)}>
            <RefreshCw size={14} strokeWidth={1.7} />
          </button>
        </div>
        <div className="files-tree">
          <RemoteDir machineId={machine.id} path={folder} depth={0} active={active} reload={reload} onOpen={setActive} />
        </div>
      </div>
      <div className="files-main">
        {active ? (
          <RemoteFilePreview machineId={machine.id} path={active} reload={reload} />
        ) : (
          <div className="files-empty">Pick a file to read it here.</div>
        )}
      </div>
    </div>
  );
}

function RemoteDir({
  machineId,
  path,
  depth,
  active,
  reload,
  onOpen,
}: {
  machineId: string;
  path: string;
  depth: number;
  active: string | null;
  reload: number;
  onOpen: (path: string) => void;
}) {
  // the folder itself starts open; the ones inside open on a click
  const [open, setOpen] = useState(depth === 0);
  return (
    <>
      {depth > 0 && (
        <button
          className="file-node dir"
          style={{ paddingLeft: 8 + (depth - 1) * 14 }}
          aria-expanded={open}
          onClick={() => setOpen((x) => !x)}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {open ? <FolderOpen size={14} strokeWidth={1.7} /> : <Folder size={14} strokeWidth={1.7} />}
          <span className="file-node-name">{fileName(path)}</span>
        </button>
      )}
      {open && <RemoteEntries machineId={machineId} path={path} depth={depth} active={active} reload={reload} onOpen={onOpen} />}
    </>
  );
}

function RemoteEntries({ machineId, path, depth, active, reload, onOpen }: React.ComponentProps<typeof RemoteDir>) {
  const tree = useRemoteTree(machineId, path, reload);
  const pad = { paddingLeft: 8 + depth * 14 };
  if (tree.state === 'loading')
    return (
      <div className="file-node muted" style={pad}>
        <Spinner size={12} />
      </div>
    );
  if (tree.state === 'unavailable')
    return (
      <div className="file-node muted" style={pad}>
        {tree.notice}
        <HostUpdateAction hostId={machineId} text={tree.notice} />
      </div>
    );
  const { entries, truncated } = tree.value;
  return (
    <>
      {entries.map((e) => {
        const full = `${tree.value.path.replace(/\/$/, '')}/${e.name}`;
        return e.isDirectory ? (
          <RemoteDir key={e.name} machineId={machineId} path={full} depth={depth + 1} active={active} reload={reload} onOpen={onOpen} />
        ) : (
          <button
            key={e.name}
            className={`file-node ${full === active ? 'active' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 + 20 }}
            onClick={() => onOpen(full)}
            title={full}
          >
            <LangIcon path={full} />
            <span className="file-node-name">{e.name}</span>
          </button>
        );
      })}
      {entries.length === 0 && (
        <div className="file-node muted" style={pad}>
          Empty folder
        </div>
      )}
      {truncated && (
        <div className="file-node muted" style={pad}>
          More files are not listed.
        </div>
      )}
    </>
  );
}

/** One file on the machine as text, read-only: the start of a long one with a line saying so, a binary one by its size, a refusal in words. */
export function RemoteFilePreview({
  machineId,
  path,
  line,
  endLine,
  reload = 0,
}: {
  machineId: string;
  path: string;
  /** the line a link named (and the last of a range): it is marked and scrolled to */
  line?: number;
  endLine?: number;
  /** changes when the file was written again: the text is read again */
  reload?: number | string;
}) {
  const file = useRemoteFile(machineId, path, reload);
  return (
    <div className="remote-file" aria-label={fileName(path)}>
      <div className="remote-file-head" title={path}>
        <LangIcon path={path} />
        <span>{fileName(path)}</span>
        <span className="remote-file-dir">{dirname(path)}</span>
      </div>
      {file.state === 'loading' && (
        <div className="files-empty">
          <Spinner size={14} />
        </div>
      )}
      {file.state === 'unavailable' && <MachineNotice text={file.notice} hostId={machineId} />}
      {file.state === 'ready' && file.value.kind === 'binary' && <div className="files-empty">Binary file, {sizeOf(file.value.size)}.</div>}
      {file.state === 'ready' && file.value.kind === 'text' && (
        <>
          <RemoteText text={file.value.text} line={line} endLine={endLine} />
          {file.value.truncated && <div className="remote-file-note">Showing the start of the file ({sizeOf(file.value.size)}).</div>}
        </>
      )}
    </div>
  );
}

/** The text, with the lines a link named marked and scrolled into view. */
function RemoteText({ text, line, endLine }: { text: string; line?: number; endLine?: number }) {
  const mark = useRef<HTMLElement>(null);
  const lines = text.split('\n');
  const from = line && line >= 1 && line <= lines.length ? line : 0;
  const to = from ? Math.min(Math.max(endLine ?? from, from), lines.length) : 0;
  useEffectOn([from, text], () => {
    mark.current?.scrollIntoView({ block: 'center' });
  });
  if (!from) return <pre className="remote-file-text">{text}</pre>;
  return (
    <pre className="remote-file-text">
      {/* the marked lines are a block of their own, so no newline stands between them and the text around */}
      {lines.slice(0, from - 1).join('\n')}
      <mark ref={mark} className="remote-file-hit">
        {lines.slice(from - 1, to).join('\n')}
      </mark>
      {lines.slice(to).join('\n')}
    </pre>
  );
}
