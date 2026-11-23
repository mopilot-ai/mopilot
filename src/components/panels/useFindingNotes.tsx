// The Changes pane's review findings: each one under its line, the one in focus scrolled to, Next, Dismiss and Fix this one.
import { useEffect, useMemo, type RefObject } from 'react';
import { FindingAnnotation } from './FindingAnnotation';
import type { DiffFile, LineNote } from '../diff/DiffView';
import { relPath } from '../../lib/paths';
import { useFindingsWalk } from './useFindingsWalk';
import { firstTierOf } from '../../harness/family';
import type { ChangesScope } from '../../lib/turnDiff';
import { askFixes, dismissFinding, focusFinding, setUnanchored, widenFindingsWalk } from '../../store/reviews';
import { chatFamily, chatHarnessLabel } from '../../store/chats';
import { useStore } from '../../store/core';

/**
 * The findings of the review the pane walks, for the chat `chatId` (another chat's walk shows nothing here). `notesFor`
 * gives a diff file its findings; `reveal` unfolds a folded file, so the finding in focus can be scrolled to. `scope` is
 * the scope `files` were read in: a walk whose scope lacks a finding's file moves to Branch.
 */
export function useFindingNotes({
  chatId,
  scope,
  files,
  fileCwd,
  listRef,
  reveal,
}: {
  chatId: string | null;
  scope: ChangesScope;
  files: DiffFile[] | null;
  fileCwd: string;
  listRef: RefObject<HTMLDivElement | null>;
  reveal: (path: string) => void;
}) {
  const asked = useStore((s) => s.diffPanel.scope);
  const { walk, review, shown, current } = useFindingsWalk(chatId);
  // subscribed: the Changes pane is memoized, so a harness switch of the walk's chat must render it again itself
  const author = useStore(() => (walk ? chatHarnessLabel(walk.chatId) : ''));
  const harness = useStore(() => (walk ? firstTierOf(chatFamily(walk.chatId)) : null));
  const fileOf = useMemo(() => {
    const byFinding = new Map<number, DiffFile>();
    for (const i of shown) {
      const file = files?.find(
        (f) => relPath(f.path, fileCwd) === relPath((review as NonNullable<typeof review>).findings[i].file, fileCwd),
      );
      if (file) byFinding.set(i, file);
    }
    return byFinding;
  }, [shown, files, fileCwd, review]);
  const unanchored = files ? shown.filter((i) => !fileOf.has(i)) : null;
  const unanchoredKey = unanchored?.join(',');
  // the transcript's rows say which findings are not in this diff
  useEffect(() => {
    if (walk && unanchoredKey !== undefined)
      setUnanchored(walk.chatId, walk.reviewId, unanchoredKey ? unanchoredKey.split(',').map(Number) : []);
  }, [walk, unanchoredKey]);
  // a finding whose file is not in the scope the walk asked for (its fixes were committed since): Branch holds it
  useEffect(() => {
    if (walk && !walk.settled && unanchoredKey && scope === asked && scope !== 'branch') widenFindingsWalk();
  }, [walk, unanchoredKey, scope, asked]);
  // the finding in focus is scrolled to, in its unfolded file, when the walk opens (again) or moves
  const currentFile = current === null ? undefined : fileOf.get(current)?.path;
  const focus = useMemo(
    () => (walk && current !== null && currentFile ? { reviewId: walk.reviewId, current, file: currentFile } : null),
    [walk, current, currentFile],
  );
  useEffect(() => {
    if (!focus) return;
    reveal(focus.file);
    const timer = setTimeout(
      () =>
        listRef.current
          ?.querySelector(`[data-review="${CSS.escape(focus.reviewId)}"][data-finding="${focus.current}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
      50,
    );
    return () => clearTimeout(timer);
  }, [focus, reveal, listRef]);

  if (!walk || !review) return { notesFor: () => [] as LineNote[] };
  const { chatId: chat, reviewId } = walk;
  const after = (i: number) => shown[(shown.indexOf(i) + 1) % shown.length];
  const notesFor = (file: DiffFile): LineNote[] =>
    shown
      .filter((i) => fileOf.get(i) === file)
      .map((i) => ({
        line: review.findings[i].line ?? 1,
        key: `finding-${reviewId}-${i}`,
        node: (
          <FindingAnnotation
            reviewId={reviewId}
            index={i}
            finding={review.findings[i]}
            status={review.statuses[i]}
            current={i === current}
            author={author}
            harness={harness}
            onNext={shown.length > 1 ? () => focusFinding(after(i)) : undefined}
            onDismiss={() => {
              const rest = shown.filter((j) => j !== i);
              if (i === current && rest.length) focusFinding(rest[Math.min(shown.indexOf(i), rest.length - 1)]);
              dismissFinding(chat, reviewId, i);
            }}
            onFix={() => askFixes(chat, reviewId, review.findings, [i])}
          />
        ),
      }));
  return { notesFor };
}
