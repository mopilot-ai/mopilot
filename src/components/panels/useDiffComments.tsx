// The Changes pane's diff comments: adding one to the chat's composer, and the composer's pending ones as notes under their lines.

import { useMemo } from 'react';
import { useStore } from '../../store/core';
import { attachToComposer } from '../../session/composerAttach';
import { diffCommentAttachment } from '../../lib/annotations';
import { relPath } from '../../lib/paths';
import type { DiffFile, LineNote } from '../diff/DiffView';
import { PendingDiffComment, type DiffCommenting } from '../diff/DiffComments';

/**
 * Comments go to the composer of the chat the pane belongs to (no chat: the new-chat composer), and stay there
 * until the message is sent; each shows under the line it ends on, in the file and folder it was made in.
 */
export function useDiffComments(threadId: string | null, fileCwd: string) {
  const attachments = useStore((s) => s.drafts[threadId ?? 'home']?.attachments);
  const pending = useMemo(() => (attachments ?? []).filter((a) => a.diff), [attachments]);
  const commentingFor = (f: DiffFile): DiffCommenting => ({
    chatId: threadId,
    path: relPath(f.path, fileCwd),
    workspace: fileCwd,
    onAdd: (range, comment) => attachToComposer(threadId, diffCommentAttachment(range, comment), { focus: false }),
  });
  const commentNotesFor = (f: DiffFile): LineNote[] => {
    const path = relPath(f.path, fileCwd);
    return pending
      .filter((a) => a.diff!.path === path && (a.diff!.workspace ?? fileCwd) === fileCwd)
      .map((a) => ({
        line: a.diff!.endLine,
        side: a.diff!.endSide,
        key: `comment:${a.annotationId}`,
        node: <PendingDiffComment range={a.diff!} comment={a.annotation} />,
      }));
  };
  return { commentingFor, commentNotesFor };
}
