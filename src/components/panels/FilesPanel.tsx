// The Files pane (⇧⌘E): the working directory's tree beside the files opened from it as tabs, each previewed or edited in place.

import { useEffect, useRef, useState } from 'react';
import { fileName } from '../../lib/paths';
import { isWin } from '../../lib/platform';
import { confirmDiscard, useFileDraft } from '../../lib/fileDrafts';
import {
  closeWorkspaceFile,
  openWorkspaceFile,
  revealInFileTree,
  setWorkspaceTree,
  useFilesWorkspace,
  workspacesShowing,
} from '../../lib/filesWorkspace';
import { get as getState, setPrefs, useStore } from '../../store/core';
import { ArrowLeftRight, FolderTree, X } from '../ui/icons';
import { LangIcon } from './DiffPanel';
import { FilePreview } from './files/FilePreview';
import { FileTree } from './files/FileTree';

export { FilePreview } from './files/FilePreview';

/** Below this width the tree and the file take turns: opening a file shows it in the tree's place. */
export const FILES_SIDE_BY_SIDE_PX = 560;

/** The pane's width, read as it changes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function FilesPanel({ cwd }: { cwd: string }) {
  const ws = useFilesWorkspace(cwd);
  const side = useStore((s) => s.prefs.filesTreeSide ?? 'left');
  const { ref, width } = useWidth();
  const roomy = width >= FILES_SIDE_BY_SIDE_PX;
  // with room, the open file shows beside the tree (the tree alone while nothing is open); without, they take turns
  const tree = ws.tree;
  const main = roomy ? !tree || !!ws.active : !tree;
  const open = (path: string, span?: { line?: number; endLine?: number }) => {
    openWorkspaceFile(cwd, path, span);
    if (!roomy) setWorkspaceTree(cwd, false);
  };
  // an edit is lost only with the file's last view: another folder's Files tab or a cited-file tab still shows it
  const close = (path: string) => {
    const elsewhere = workspacesShowing(path, cwd) || getState().paneTabs.some((t) => t.kind === 'file' && t.path === path);
    if (elsewhere || confirmDiscard([path])) closeWorkspaceFile(cwd, path);
  };
  const sideLabel = side === 'left' ? 'Move file tree to the right' : 'Move file tree to the left';
  return (
    <div ref={ref} className={`files-workspace tree-${side}`}>
      {tree && <FileTree cwd={cwd} active={ws.active} reveal={ws.reveal} onOpen={open} />}
      {main ? (
        <div className="files-main">
          <div className="files-tabs" role="tablist" aria-label="Open files">
            <button
              className={`cp-tool ${tree ? 'on' : ''}`}
              aria-label={tree ? 'Hide file tree' : 'Show file tree'}
              aria-pressed={tree}
              title={tree ? 'Hide file tree' : 'Show file tree'}
              onClick={() => setWorkspaceTree(cwd, !tree)}
            >
              <FolderTree size={15} strokeWidth={1.7} />
            </button>
            {ws.open.map((path) => (
              <FileTab
                key={path}
                path={path}
                active={path === ws.active}
                onSelect={() => openWorkspaceFile(cwd, path)}
                onClose={() => close(path)}
              />
            ))}
            {roomy && tree && (
              <button
                className="cp-tool files-tree-side"
                title={sideLabel}
                aria-label={sideLabel}
                onClick={() => setPrefs({ filesTreeSide: side === 'left' ? 'right' : 'left' })}
              >
                <ArrowLeftRight size={14} />
              </button>
            )}
          </div>
          {ws.active ? (
            <FilePreview
              path={ws.active}
              cwd={cwd}
              line={ws.span.line}
              endLine={ws.span.endLine}
              seq={ws.seq}
              onReveal={() => revealInFileTree(cwd, ws.active!)}
            />
          ) : (
            <div className="files-empty">Show the file tree to pick a file.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function FileTab({ path, active, onSelect, onClose }: { path: string; active: boolean; onSelect: () => void; onClose: () => void }) {
  const { draft } = useFileDraft(path);
  const name = fileName(path, isWin);
  return (
    <div className={`files-tab ${active ? 'active' : ''}`} title={path}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className="files-tab-name"
        onClick={onSelect}
        onAuxClick={(e) => {
          if (e.button === 1) onClose();
        }}
      >
        <LangIcon path={path} />
        <span>{name}</span>
        {draft && (
          <span className="files-tab-dirty" role="img" aria-label="Unsaved changes">
            ●
          </span>
        )}
      </button>
      <button type="button" className="files-tab-close" aria-label={`Close ${name}`} onClick={onClose}>
        <X size={12} />
      </button>
    </div>
  );
}
