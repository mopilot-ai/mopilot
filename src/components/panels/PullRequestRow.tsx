// The Changes card's pull requests: the chat's tracked PR and its stack with their controls (Claude Desktop keeps them
// on its session rail, not above the message box), else the branch's PR to attach, or Create (a form, made in the app);
// and tracking by URL.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from '../../store/core';
import { native } from '../../lib/native';
import { openLink } from '../../session/open';
import { GithubMark } from '../ui/icons';
import { usePrMonitor, type PrMonitorApi } from '../thread/usePrMonitor';
import { PrMonitorRows } from '../thread/PrMonitor';
import { busyField, imeComposing } from '../../lib/focus';
import { PrCreateForm } from './PrCreateForm';

/** The pull request `gh pr view` found for the folder's branch. */
type BranchPr = { number: number; url: string; title: string; state: string };
export type BranchPrLookup = BranchPr | 'unavailable' | null | undefined;

type PullRequestRowProps = {
  chatId: string;
  checkoutVersion: number | null;
  hasRemote: boolean;
  branchPr: BranchPrLookup;
  entering: boolean;
  setEntering: (on: boolean) => void;
  retryLookup: () => void;
};

/** A chat-keyed child prevents another chat's pending attach from landing in this one's row. */
export function PullRequestRow(props: PullRequestRowProps) {
  return <PullRequestRowFor key={props.chatId} {...props} api={native.prMonitor} />;
}

export function PullRequestRowFor({
  chatId,
  checkoutVersion,
  hasRemote,
  branchPr,
  entering,
  setEntering,
  retryLookup,
  api,
}: PullRequestRowProps & { api: PrMonitorApi }) {
  // one read for the rows and the attach form, so a write from either shows in both and busy is one flag
  const monitor = usePrMonitor(chatId, api);
  const { state, error, busy, mutate } = monitor;
  const [url, setUrl] = useState('');
  const [creatingFor, setCreatingFor] = useState<number | null>(null);
  const creating = creatingFor !== null && creatingFor === checkoutVersion;
  if (creatingFor !== null && !creating) setCreatingFor(null);
  const input = useRef<HTMLInputElement>(null);
  // the menu item that opens the form asks for exactly this input
  useEffect(() => {
    if (entering) input.current?.focus();
  }, [entering]);
  const track = async (link: string) => {
    const failed = await mutate({ url: link });
    if (failed) return failed;
    toast('Pull request attached');
    setEntering(false);
    setUrl('');
    return '';
  };
  let row: ReactNode = null;
  if (state) row = <PrMonitorRows chatId={chatId} api={api} open={openLink} monitor={monitor} />;
  else if (!hasRemote) row = null;
  else if (branchPr === 'unavailable')
    row = (
      <button type="button" className="summary-row" onClick={retryLookup}>
        <GithubMark size={16} />
        <span className="summary-label">Pull request unavailable</span>
        <span className="summary-hint summary-action">Retry</span>
      </button>
    );
  else if (branchPr?.state === 'OPEN')
    row = (
      <button
        className="summary-row"
        title={`#${branchPr.number} ${branchPr.title}`}
        disabled={busy}
        onClick={async () => {
          const failed = await track(branchPr.url);
          if (failed) toast(failed, 'error');
        }}
      >
        <GithubMark size={16} />
        <span className="summary-label">Existing pull request</span>
        <span className="summary-hint summary-action">Attach</span>
      </button>
    );
  else if (branchPr)
    row = (
      <button className="summary-row" onClick={() => openLink(branchPr.url)}>
        <GithubMark size={16} />
        <span className="summary-label">{`#${branchPr.number} ${branchPr.title}`}</span>
        <span className="summary-hint">{branchPr.state.toLowerCase()}</span>
      </button>
    );
  else if (branchPr === null)
    row = (
      <button className="summary-row" aria-expanded={creating} onClick={() => setCreatingFor(creating ? null : checkoutVersion)}>
        <GithubMark size={16} />
        <span className="summary-label">Pull request</span>
        <span className="summary-hint summary-action">Create</span>
      </button>
    );
  return (
    <>
      {row}
      {/* a pull request this chat now tracks (made here, or attached meanwhile) ends the form */}
      {creating && !state && branchPr === null && (
        <PrCreateForm chatId={chatId} api={api} unavailable={!hasRemote} onClose={() => setCreatingFor(null)} />
      )}
      {entering && (
        <form
          className="summary-track"
          onSubmit={(e) => {
            e.preventDefault();
            void track(url.trim());
          }}
        >
          <input
            aria-label="Pull request URL"
            placeholder="https://github.com/owner/repo/pull/123"
            value={url}
            {...busyField(busy)}
            ref={input}
            className="text-input"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              // the form's own Escape: it closes the form, not the turn or pane behind it
              if (e.key !== 'Escape' || imeComposing(e)) return;
              e.stopPropagation();
              setEntering(false);
            }}
          />
          <div className="summary-track-actions">
            <button type="button" className="link-btn" onClick={() => setEntering(false)}>
              Cancel
            </button>
            <button type="submit" className="btn-pill" disabled={busy || !url.trim()}>
              Track
            </button>
          </div>
          {/* a tracked PR's rows already say it, under them */}
          {error && !state && (
            <p className="summary-track-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </>
  );
}
