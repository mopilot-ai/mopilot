// Native browser grants and Claude in Chrome tool approval cards.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useWindowListener } from '../../../lib/effects';
import { useStore } from '../../../store/core';
import { resolveRequest } from '../../../store/notifications';
import type { PendingRequest } from '../../../store/types';
import { Globe, AlertTriangle } from '../../ui/icons';
import { allowsAllSites, browserUseAnswer, type BrowserUseApproval, type BrowserUseChoice } from '../../../harness/elicitation';
import { chromeApproval, chromeSuggestion, chromeTabUrl } from '../../../harness/chromeApproval';
import { codexApi } from '../../../harness/adapters/codexApi';
import { approvalKey, approvesOnEnter, cardOwnsKey, isTypingTarget } from '../approvalLogic';
import { Card, Rows, type ElicitationRequest, type ElicitationView } from './shared';
/** What the card says Codex wants, with the site's host first. */
function browserMessage(a: BrowserUseApproval, agent: string, message: unknown): React.ReactNode {
  const site = a.host ? <strong className="browser-site">{a.host}</strong> : (a.origin ?? 'this site');
  switch (a.kind) {
    case 'origin':
      return (
        <>
          {agent} wants to use {site}
        </>
      );
    case 'devtools':
      return (
        <>
          {agent} wants full DevTools access on {site}
        </>
      );
    case 'upload':
      return (
        <>
          {agent} wants to upload files to {site}
        </>
      );
    case 'download':
      return (
        <>
          {agent} wants to download files from {site}
        </>
      );
    case 'assets':
      return (
        <>
          {agent} wants to download page assets from {site}
        </>
      );
    case 'history':
      return <>{agent} wants to use your browsing history</>;
    case 'webmcp':
      return (
        <>
          {agent} wants to run a WebMCP tool on {site}
        </>
      );
    default:
      return typeof message === 'string' && message.trim() ? message : `${agent} wants to take a browser action`;
  }
}

/** Whether Codex's requirements let a grant cover every site; read only when the request offers one. */
function useAllSitesAllowed(asked: boolean): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!asked) return;
    let live = true;
    codexApi.configRequirementsRead().then(
      (r) => {
        if (live) setOk(allowsAllSites(r));
      },
      () => {
        /* unreadable requirements: keep offering per-site grants only */
      },
    );
    return () => {
      live = false;
    };
  }, [asked]);
  return ok;
}

/**
 * Codex's Browser plugin asking before it uses a site (or its DevTools, the browsing history, a file
 * transfer, a WebMCP tool): the grants the request offers as buttons, 1, 2, 3 or Enter for the first,
 * Esc to decline. "Allow for all sites" asks once more before it answers. Only a person's input counts.
 */
export function BrowserUseCard({ req, approval, agent }: { req: ElicitationRequest; approval: BrowserUseApproval; agent: string }) {
  const p: ElicitationView = req.params;
  const root = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const allSites = useAllSitesAllowed(approval.choices.some((c) => c.value === 'allSites'));
  const choices = approval.choices.filter((c) => c.value !== 'allSites' || allSites);
  const answer = (choice: string) => resolveRequest(req.id, browserUseAnswer(p, choice));
  const pick = (choice: BrowserUseChoice) => (choice === 'allSites' ? setConfirming(true) : answer(choice));
  useWindowListener('keydown', (e) => {
    if (isTypingTarget(e.target as HTMLElement | null) || document.querySelector('.popover-layer') || !cardOwnsKey(e, root.current)) return;
    const k = approvalKey(e, { choices: confirming ? 0 : choices.length, destructive: false });
    // the risk step takes a click (or Enter on its focused button); Esc goes back to the choices
    if (confirming) {
      if (k?.type === 'deny') {
        e.preventDefault();
        setConfirming(false);
      }
      return;
    }
    if (approvesOnEnter(e)) {
      e.preventDefault();
      return pick(choices[0].value);
    }
    if (!k) return;
    e.preventDefault();
    if (k.type === 'deny') answer('decline');
    else if (k.type === 'choose') pick(choices[k.index].value);
  });
  const human = (fn: () => void) => (e: React.MouseEvent) => e.nativeEvent.isTrusted && fn();
  return (
    <div ref={root} className="approval-card sage-approval browser-use" data-kind={approval.kind}>
      <div className="approval-top">
        <div className="approval-kind">
          <Globe size={18} strokeWidth={1.6} />
          <span>{approval.browser ? `Browser · ${approval.browser}` : 'Browser'}</span>
        </div>
        <div className="approval-message">{browserMessage(approval, agent, p.message)}</div>
        {approval.host && approval.origin !== `https://${approval.host}` && <div className="browser-origin">{approval.origin}</div>}
      </div>
      <div className="approval-detail">
        {approval.reason && <p className="sage-access-hint">“{approval.reason}”</p>}
        {approval.details.length > 0 && <Rows rows={approval.details} />}
        {approval.highRisk && (
          <div className="desktop-access-warning" role="alert">
            <AlertTriangle size={13} strokeWidth={1.6} /> Can read and change anything on this site.
          </div>
        )}
        {approval.sensitive && (
          <div className="desktop-access-warning" role="alert">
            <AlertTriangle size={13} strokeWidth={1.6} /> Marked sensitive. Allow only if you expected it.
          </div>
        )}
        {confirming && (
          <div className="browser-confirm" role="alertdialog" aria-label="Allow for all sites">
            <p className="approval-message">Allow {agent} to use any website without asking?</p>
            <p className="desktop-access-warning">
              <AlertTriangle size={13} strokeWidth={1.6} /> Including sites you're signed in to.
            </p>
          </div>
        )}
      </div>
      <div className="approval-foot">
        {confirming ? (
          <>
            <button className="ap-btn deny" onClick={human(() => setConfirming(false))}>
              Cancel <kbd>Esc</kbd>
            </button>
            <button className="ap-btn allow solo" autoFocus onClick={human(() => answer('allSites'))}>
              Allow any website
            </button>
          </>
        ) : (
          <>
            <button className="ap-btn deny" onClick={human(() => answer('decline'))}>
              Decline <kbd>Esc</kbd>
            </button>
            {choices.map((c, i) => (
              <button key={c.value} className="ap-btn allow solo" onClick={human(() => pick(c.value))}>
                {c.label} <kbd>{i + 1}</kbd>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Claude Code asking to use a Claude in Chrome tool: the action and its site in words, the input as
 * rows. The "don't ask again" choice comes only from the CLI's suggestions, labeled by what they keep;
 * without them the card offers Allow once and Deny.
 */
export function ChromeToolApproval({ req }: { req: PendingRequest<'claude/toolApproval'> }) {
  const p = req.params;
  const turns = useStore((s) => s.runtime[String(req.threadId)]?.turns);
  const tabId = p.input?.tabId;
  const knownUrl = useMemo(
    () =>
      chromeTabUrl(
        (turns ?? []).flatMap((t) => t.items),
        tabId,
      ),
    [turns, tabId],
  );
  const view = chromeApproval(p.toolName, p.input, knownUrl)!;
  const keep = chromeSuggestion(p._claude?.suggestions);
  return (
    <Card
      req={req}
      icon={<Globe size={18} strokeWidth={1.6} />}
      kind="Claude in Chrome"
      message={
        view.host ? (
          <>
            {view.action} on <strong className="browser-site">{view.host}</strong>
          </>
        ) : (
          view.action
        )
      }
      primary={{ label: 'Allow once', result: { decision: 'accept' } }}
      more={keep ? [{ label: keep.label, hint: keep.hint, result: { decision: 'acceptForSession' } }] : []}
      deny={{ decision: 'decline' }}
    >
      {view.rows.length > 0 && <Rows rows={view.rows} />}
      {view.block && <div className="approval-cmd">{view.block}</div>}
      {p.reason && <div className="approval-cwd">{String(p.reason)}</div>}
    </Card>
  );
}
