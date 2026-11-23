// The edited files card under a completed turn: the changed files and undo.

import { useEffect, useState } from 'react';
import { ChevronDown, Undo2 } from '../ui/icons';
import { diffTotals } from '../../lib/diff';
import { absPath } from '../../lib/paths';
import { useFileMenu } from '../ui/FileMenu';

export interface EditedFile {
  path: string;
  label: string;
  added: number;
  removed: number;
}

/** Completed-turn changes, with a compact file list and independent undo action. */
export function EditedFilesCard({
  files,
  cwd,
  undone,
  busy,
  expanded,
  onExpand,
  onView,
  onUndo,
}: {
  files: EditedFile[];
  /** the chat's folder, so a row's menu reveals the file by its absolute path */
  cwd?: string | null;
  undone: boolean;
  busy: boolean;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  onView: (path?: string) => void;
  /** absent: the files are not on this Mac (a chat on a machine), so there is nothing to undo here */
  onUndo?: () => void;
}) {
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (!expanded) setPage(0);
  }, [expanded]);
  const pageSize = 20;
  const lastPage = Math.max(0, Math.ceil(files.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * pageSize;
  const name = `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
  const visibleFiles = expanded ? files.slice(start, start + pageSize) : files.slice(0, 3);
  const total = diffTotals(files);
  return (
    <div className={`edited-card ${undone ? 'undone' : ''}`}>
      <div className="edited-header">
        <button className="edited-overview" onClick={() => onView()} aria-label={`View changes to ${name}`}>
          <span className="edited-icon">
            {/* ± in a rounded square, as in the official card */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <rect x="4" y="3.5" width="16" height="17" rx="3" />
              <path d="M12 7.5v6M9 10.5h6M9 16.5h6" />
            </svg>
          </span>
          <span className="edited-main">
            <span className="edited-title">{undone ? `Undid changes to ${name}` : `Edited ${name}`}</span>
            <span className="edited-overview-detail">
              <span className="edited-stats">
                <span className="plus">+{total.added}</span> <span className="minus">-{total.removed}</span>
              </span>
              <span className="edited-view-hint">
                View changes <span aria-hidden="true">↗</span>
              </span>
            </span>
          </span>
        </button>
        <span className="edited-actions">
          {expanded && files.length > 3 && (
            <button className="btn-pill ghost" aria-expanded={true} onClick={() => onExpand(false)}>
              Show less
            </button>
          )}
          {onUndo && (
            <button className="btn-pill ghost" onClick={onUndo} disabled={busy}>
              {undone ? 'Redo' : 'Undo'} <Undo2 size={14} />
            </button>
          )}
          <button className="btn-pill" onClick={() => onView()}>
            View changes
          </button>
        </span>
      </div>
      <div className="edited-files">
        <div className="edited-file-list" key={currentPage}>
          {visibleFiles.map((file) => (
            <EditedFileRow key={file.path} file={file} cwd={cwd} onView={onView} />
          ))}
        </div>
        {expanded && files.length > pageSize && (
          <div className="edited-pagination">
            <button
              className="btn-pill ghost"
              aria-label="Previous files"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </button>
            <span aria-live="polite">
              {start + 1}–{Math.min(start + pageSize, files.length)} of {files.length} files
            </span>
            <button
              className="btn-pill ghost"
              aria-label="Next files"
              disabled={currentPage === lastPage}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </button>
          </div>
        )}
        {files.length > 3 && (
          <button className="edited-expand" aria-expanded={expanded} onClick={() => onExpand(!expanded)}>
            {expanded ? 'Show less' : `Show ${files.length - 3} more ${files.length - 3 === 1 ? 'file' : 'files'}`}
            {expanded ? <ChevronDown size={14} style={{ transform: 'rotate(180deg)' }} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}

/** One changed file: the click views its diff, and its path's menu is a right-click or the keyboard away. */
function EditedFileRow({ file, cwd, onView }: { file: EditedFile; cwd?: string | null; onView: (path?: string) => void }) {
  const menu = useFileMenu(absPath(file.path, cwd));
  return (
    <>
      {/* a compact row with no space for a menu button of its own */}
      <button className="edited-file" onClick={() => onView(file.path)} title={file.label} {...menu.target}>
        <span className="edited-file-path">{file.label}</span>
        <span className="edited-stats">
          <span className="plus">+{file.added}</span> <span className="minus">-{file.removed}</span>
        </span>
      </button>
      {menu.menu}
    </>
  );
}
