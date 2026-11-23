// The Changes pane's pull request review comments, as Claude Desktop's diff shows them: in the Branch scope the open PR of the folder's branch is read, each thread goes under its line (resolved ones folded), Next unresolved comment walks them, Answer review comments asks the chat, and a line comment can be posted to GitHub.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { relPath } from '../../lib/paths';
import { errorText } from '../../lib/ignored';
import { useEffectOn } from '../../lib/effects';
import { visiblePoll } from '../../lib/visiblePoll';
import { native } from '../../lib/native';
import { nextUnresolved, unresolvedOrder, type ReviewThread } from '../../lib/prReviewThreads';
import { postReviewComment, readBranchReview, type BranchReview } from '../../lib/prReviewGit';
import { answerReviewComments } from '../../store/reviews';
import { toast } from '../../store/core';
import type { DiffFile, LineNote } from '../diff/DiffView';
import type { DiffCommentRange } from '../../../shared/diffComments.mjs';
import { ReviewThreadNote } from './ReviewThreadNote';
import { openUrl } from '../../session/open';
import { diffFingerprint } from '../../lib/diffReview';

/** How often the threads are read again while the pane shows the Branch scope. */
export const REVIEW_POLL_MS = 120_000;
export const POST_FAILED = 'Could not post the comment to GitHub. Your comment is kept so you can retry.';

type Loaded = { context: object; cwd: string; review: BranchReview | null; error: string | null; edited: ReadonlySet<string> };

export function useReviewThreads({
  enabled = true,
  chatId,
  cwd,
  scope,
  files,
  listRef,
  reveal,
  clearFilter,
}: {
  /** false: the folder is not on this Mac, so no pull request is read for it */
  enabled?: boolean;
  chatId: string | null;
  cwd: string;
  scope: string;
  files: readonly DiffFile[] | null;
  listRef: RefObject<HTMLElement | null>;
  reveal: (path: string) => void;
  clearFilter: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const request = useRef(0);
  const active = enabled && scope === 'branch';
  const context = useMemo(() => ({ cwd, scope, chatId }), [cwd, scope, chatId]);
  const owner = useRef<typeof context | null>(context);
  owner.current = context;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const latestFiles = useRef(files);
  latestFiles.current = files;
  // the newest read wins: an older one answering late (the folder changed, a poll overlapped) is dropped
  const load = useCallback(async () => {
    if (!mounted.current || owner.current !== context) return;
    const asked = ++request.current;
    try {
      const [review, status] = await Promise.all([readBranchReview(cwd), native.git.status(cwd)]);
      if (review && !status) throw new Error('Couldn’t check local changes. Try again.');
      // files with edits not yet committed: their lines are not the PR's, so a comment on them can't go to GitHub
      const edited = new Set((status?.files ?? []).map((f) => f.path));
      if (asked === request.current && mounted.current && owner.current === context)
        setLoaded({ context, cwd, review, error: null, edited });
    } catch (error) {
      if (asked === request.current && mounted.current && owner.current === context)
        setLoaded((old) => ({
          context,
          cwd,
          review: old?.context === context ? old.review : null,
          error: errorText(error) || 'Couldn’t read review comments',
          edited: old?.edited ?? new Set(),
        }));
    }
  }, [cwd, context]);
  useEffectOn([active, load], () => {
    if (!active) return;
    void load();
    const stop = visiblePoll('changes-review-threads', REVIEW_POLL_MS, () => void load());
    return () => {
      request.current++;
      stop();
    };
  });
  const current = active && loaded?.context === context ? loaded : null;
  const review = current?.review ?? null;
  const unresolved = review ? unresolvedOrder(review.threads) : [];
  const toggleThread = (id: string) =>
    setUnfolded((u) => {
      const next = new Set(u);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const notesFor = (f: DiffFile): LineNote[] => {
    if (!review) return [];
    const path = relPath(f.path, cwd);
    return review.threads
      .filter((t) => t.path === path)
      .map((t) => ({
        line: t.line ?? 0,
        side: t.side,
        key: `thread:${t.id}`,
        node: <ReviewThreadNote thread={t} focused={focus === t.id} unfolded={unfolded.has(t.id)} onToggle={() => toggleThread(t.id)} />,
      }));
  };

  const next = review ? nextUnresolved(review.threads, focus) : null;
  const goNext = (thread: ReviewThread) => {
    setFocus(thread.id);
    clearFilter();
    const file = files?.find((f) => relPath(f.path, cwd) === thread.path);
    if (file) reveal(file.path);
    // a frame on, once its file is unfolded and the note drawn
    requestAnimationFrame(() => {
      if (mounted.current && owner.current === context)
        listRef.current?.querySelector(`[data-thread="${CSS.escape(thread.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  };

  /** Posting to GitHub, for a file whose lines are the PR's (no uncommitted edits) while the PR's head is known. */
  const onPostFor = (f: DiffFile): ((range: DiffCommentRange, body: string) => Promise<boolean>) | undefined => {
    if (!review?.head || current!.error || current!.edited.has(relPath(f.path, cwd))) return undefined;
    return async (range, body) => {
      try {
        await postReviewComment(
          cwd,
          review,
          range,
          body,
          f,
          () =>
            mounted.current &&
            owner.current === context &&
            !!latestFiles.current?.some((now) => now.path === f.path && diffFingerprint(now) === diffFingerprint(f)),
        );
        toast('Comment posted on GitHub', 'success');
        void load();
        return true;
      } catch (error) {
        toast(`${POST_FAILED} ${errorText(error)}`.trim(), 'error');
        void load();
        return false;
      }
    };
  };

  let bar: ReactNode = null;
  if (current?.error)
    bar = (
      <div className="cp-review-bar" role="alert">
        <span>Couldn’t read the pull request’s review comments: {current.error}</span>
        <button type="button" className="btn-pill" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  else if (review && (unresolved.length || review.limited))
    bar = (
      <div className="cp-review-bar">
        <span>
          {review.limited && 'Loaded: '}
          {unresolved.length === 1 ? '1 unresolved review comment' : `${unresolved.length} unresolved review comments`} on #
          {review.pr.number}
        </span>
        {review.limited && (
          <button type="button" className="btn-pill" onClick={() => openUrl(review.pr.url)}>
            More comments on GitHub
          </button>
        )}
        <button type="button" className="btn-pill" disabled={!next} onClick={next ? () => goNext(next) : undefined}>
          Next unresolved comment
        </button>
        {chatId && unresolved.length > 0 && (
          <button type="button" className="btn-pill primary" onClick={() => answerReviewComments(chatId, review.pr)}>
            {unresolved.length === 1 ? 'Answer 1 review comment' : `Answer ${unresolved.length} review comments`}
          </button>
        )}
      </div>
    );
  const unanchored = review?.threads.filter((t) => !files?.some((f) => relPath(f.path, cwd) === t.path)) ?? [];
  const extra = unanchored.map((thread) => (
    <div key={thread.id} className="cp-review-unanchored">
      <span>{thread.path}</span>
      <ReviewThreadNote
        thread={thread}
        focused={focus === thread.id}
        unfolded={unfolded.has(thread.id)}
        onToggle={() => toggleThread(thread.id)}
      />
    </div>
  ));
  return {
    notesFor,
    onPostFor,
    bar,
    extra,
    refresh: () => {
      if (active) void load();
    },
  };
}
