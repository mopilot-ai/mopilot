// A file's header in the Changes pane: its name (and "whitespace only"), whether it changed since the user marked it Viewed, its line counts, Viewed, Open, and its menu (Copy path, Reveal in Finder, Attach as context, Discard changes); what the pane's source cannot do is greyed with its reason.

import { fileName, relPath } from '../../lib/paths';
import { localChangesSource, type ChangesSource } from '../../lib/changesSource';
import { isWin } from '../../lib/platform';
import { onActivate } from '../../lib/focus';
import { openPath } from '../../session/open';
import { attachToComposer } from '../../session/composerAttach';
import { toast } from '../../store/core';
import type { DiffFile } from '../diff/DiffView';
import type { ViewedState } from '../../lib/diffViewed';
import { MenuItem, Tooltip } from '../ui/Popover';
import { useFileMenu } from '../ui/FileMenu';
import { Ellipsis, ExternalLink } from '../ui/icons';
import { LangIcon } from './DiffPanel';

export function ChangesFileHead({
  file,
  cwd,
  conflicted = false,
  source: given,
  chatId,
  expanded,
  viewed,
  whitespaceOnly,
  openLabel,
  onToggle,
  onViewed,
  onDiscard,
}: {
  file: DiffFile;
  cwd: string;
  /** the file is in conflict (git lists it as unmerged) */
  conflicted?: boolean;
  /** where the file's folder is, and what that can do with the file (default: `cwd` on this Mac) */
  source?: ChangesSource;
  /** the chat whose composer Attach as context adds to (null: the new chat's) */
  chatId: string | null;
  expanded: boolean;
  viewed: ViewedState;
  whitespaceOnly: boolean;
  openLabel: string;
  onToggle: () => void;
  onViewed: (viewed: boolean) => void;
  onDiscard?: () => void;
}) {
  const source = given ?? localChangesSource(cwd);
  const rel = relPath(file.path, cwd);
  const path = source.pathOf(file.path, cwd);
  const { openInEditor } = source.capabilities;
  return (
    // a row, not a <button>: it holds the file's own buttons
    <div
      className="cp-file-head"
      role="button"
      aria-label={rel}
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={onActivate(onToggle)}
    >
      <LangIcon path={file.path} />
      <span className="cp-file-name" title={file.path}>
        {rel}
        {whitespaceOnly && <span className="cp-file-note"> (whitespace only)</span>}
      </span>
      {conflicted && <span className="cp-file-badge conflicted">Conflicted</span>}
      {viewed === 'changed' && <span className="cp-file-badge">Changed since you viewed it</span>}
      <span className="diff-stat">
        <span className="plus">+{file.added}</span> <span className="minus">-{file.removed}</span>
      </span>
      {/* not a control: it keeps its buttons' clicks from also folding the file (onActivate ignores their keys) */}
      <span className="cp-file-actions cp-review-actions" role="presentation" onClick={(e) => e.stopPropagation()}>
        <label className="cp-viewed">
          <input
            type="checkbox"
            checked={viewed === 'viewed'}
            disabled={file.binary && !file.binaryVersion}
            title={file.binary && !file.binaryVersion ? 'This binary change has no version to track' : undefined}
            aria-label={`Viewed ${rel}`}
            onChange={(e) => onViewed(e.target.checked)}
          />
          Viewed
        </label>
        {openInEditor.on ? (
          <Tooltip label={openLabel}>
            <button className="icon-btn xs" aria-label={openLabel} onClick={() => openPath(path)}>
              <ExternalLink size={14} />
            </button>
          </Tooltip>
        ) : (
          // a disabled button gets no pointer events: its wrapper carries the reason
          <span title={openInEditor.reason}>
            <button className="icon-btn xs" aria-label={openLabel} disabled>
              <ExternalLink size={14} />
            </button>
          </span>
        )}
        <FileActions path={path} source={source} chatId={chatId} onDiscard={onDiscard} />
      </span>
    </div>
  );
}

function FileActions({
  path,
  source,
  chatId,
  onDiscard,
}: {
  path: string;
  source: ChangesSource;
  chatId: string | null;
  onDiscard?: () => void;
}) {
  const { attach: attachCap, reveal } = source.capabilities;
  const attach = () => {
    const name = fileName(path, isWin);
    if (attachToComposer(chatId, { kind: 'file', name, path }) === false) return;
    toast(`Attached ${name}`, 'success');
  };
  const m = useFileMenu(path, {
    ...(!reveal.on && { revealOff: reveal.reason }),
    extra: (
      <>
        {attachCap.on ? (
          <MenuItem onSelect={attach}>Attach as context</MenuItem>
        ) : (
          <MenuItem disabled description={attachCap.reason}>
            Attach as context
          </MenuItem>
        )}
        {onDiscard && (
          <MenuItem danger onSelect={onDiscard}>
            Discard changes
          </MenuItem>
        )}
      </>
    ),
  });
  return (
    <>
      <Tooltip label="File actions">
        <button className="icon-btn xs" {...m.trigger}>
          <Ellipsis size={14} />
        </button>
      </Tooltip>
      {m.menu}
    </>
  );
}
