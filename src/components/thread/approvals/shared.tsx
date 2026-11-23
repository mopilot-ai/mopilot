// Shared approval card frame, request source labels and host answers.
import { useRef, useState } from 'react';
import { useWindowListener } from '../../../lib/effects';
import { useStore, toast, toastFailure } from '../../../store/core';
import { resolveRequest } from '../../../store/notifications';
import { sendOrDraft } from '../../../store/send';
import { chatHarnessLabel, chatOf } from '../../../store/chats';
import type { PendingRequest } from '../../../store/types';
import { Menu, MenuItem, Tooltip, useAnchor } from '../../ui/Popover';
import { native, type SageApprovalAnswer } from '../../../lib/native';
import { ChevronDown, Info } from '../../ui/icons';
import { CardClock } from './CardClock';
import type { Segment } from '../../../harness/types';
import { HARNESS_LABEL } from '../../../harness/types';
import { acpLabelOf } from '../../../session/harness/acp';
import { isFirstTier } from '../../../harness/adapter';
import { MAX_KEY_CHOICES, approvalKey, approvesOnEnter, cardOwnsKey, denialWith, isTypingTarget, sourceLabel } from '../approvalLogic';
import { isEnter } from '../../../lib/focus';
import { withKeys } from '../../../lib/listKeys';
import { errorText } from '../../../lib/ignored';
import { answerTaken } from '../../../store/answerRetired';
import { approvalHarness } from '../../../../shared/approvalOrigin.mjs';
import { harnessInfo } from '../../../harness/registry';

/** What a card says when nothing names who is asking. */
export const NO_SOURCE = 'The agent';
const segmentLabel = (s: Segment) => (isFirstTier(s.harness) ? HARNESS_LABEL[s.harness] : acpLabelOf(s.nativeId));
/** Who is asking: the harness of the segment that sent the request (it may not be the chat's current one). */
export function useSourceLabel(threadId: string, params: unknown, sourceHarness?: PendingRequest['sourceHarness']) {
  const segments = useStore((s) => s.segments[threadId]);
  const origin = approvalHarness({ sourceHarness, params });
  if (origin !== undefined) return origin === null ? NO_SOURCE : (harnessInfo(origin)?.label ?? acpLabelOf(origin)) || NO_SOURCE;
  return sourceLabel(params, segments, segmentLabel, chatHarnessLabel(threadId));
}
/**
 * Sends the person's answer to a card MoPilot asked itself (main's broker). The card stays until main
 * takes the answer, so a send that fails says so instead of leaving the agent waiting with no sign why, and one
 * main had retired (answered elsewhere, the turn stopped) says it was already answered.
 */
export function answerSageCard(id: string, result: SageApprovalAnswer) {
  native.computer.answer(id, result).then(
    (taken) => answerTaken(taken, toast),
    (e) => toast(`Couldn't send your answer: ${errorText(e)}`, 'error'),
  );
}

export interface Choice {
  label: string;
  result: unknown;
  hint?: string;
}

/** Card shown in place of the composer. `primary` is "Allow once"; `more` go in the dropdown. */
export function Card({
  icon,
  kind,
  message,
  children,
  primary,
  more = [],
  deny,
  req,
}: {
  icon: React.ReactNode;
  kind: string;
  message: React.ReactNode;
  children?: React.ReactNode;
  primary: Choice;
  more?: Choice[];
  deny: unknown;
  req: PendingRequest;
}) {
  const root = useRef<HTMLDivElement>(null);
  // Claude Code reads why a tool was denied, so the note goes back with the denial. The other
  // harnesses have no such field: their note is sent as the next message instead.
  const carries = String(req.id).startsWith('cperm-');
  const [note, setNote] = useState('');
  const denial = denialWith(deny, note, carries);
  const choices = [primary, ...more];
  const refuse = () => {
    resolveRequest(req.id, denial);
    // one main didn't take (it said why) waits in the chat's composer, so the note isn't lost
    if (!carries && note.trim() && req.threadId)
      sendOrDraft(chatOf(req.threadId), note.trim(), { human: true }).catch(toastFailure("Couldn't send your note"));
  };
  useWindowListener('keydown', (e) => {
    if (isTypingTarget(e.target as HTMLElement | null) || document.querySelector('.popover-layer') || !cardOwnsKey(e, root.current)) return;
    if (approvesOnEnter(e)) {
      e.preventDefault();
      return resolveRequest(req.id, primary.result);
    }
    const k = approvalKey(e, { choices: choices.length, destructive: false });
    if (!k) return;
    e.preventDefault();
    // the card isn't destructive, so a key is a denial or a choice
    if (k.type === 'choose') resolveRequest(req.id, choices[k.index].result);
    else refuse();
  });
  return (
    <div ref={root} className="approval-card">
      <div className="approval-top">
        <div className="approval-kind">
          {icon}
          <span>{kind}</span>
        </div>
        <div className="approval-message">{message}</div>
        <CardClock threadId={req.threadId} />
      </div>
      {children && <div className="approval-detail">{children}</div>}
      <input
        className="text-input approval-note"
        placeholder="Tell the agent what to do instead (optional)"
        aria-label="Denial note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (isEnter(e) && note.trim()) refuse();
        }}
      />
      <div className="approval-foot">
        <button className="ap-btn deny" onClick={refuse}>
          Deny <kbd>Esc</kbd>
        </button>
        <AllowSplit
          autoFocus
          label={primary.label}
          kbd="⏎"
          onAllow={() => resolveRequest(req.id, primary.result)}
          menu={
            more.length > 0
              ? choices.map((c, i) => (
                  <MenuItem
                    key={c.label}
                    onSelect={() => resolveRequest(req.id, c.result)}
                    right={
                      <>
                        {c.hint && (
                          <Tooltip label={c.hint}>
                            <span className="ap-info">
                              <Info size={15} />
                            </span>
                          </Tooltip>
                        )}
                        {i < MAX_KEY_CHOICES && <kbd>{i + 1}</kbd>}
                      </>
                    }
                  >
                    {c.label}
                  </MenuItem>
                ))
              : null
          }
        />
      </div>
    </div>
  );
}

/** A click that counts only when a person made it (React reads isTrusted from the native event). */
export const humanClick =
  (fn: () => void) =>
  (e: { nativeEvent: Event }): void => {
    if (e.nativeEvent.isTrusted) fn();
  };

/**
 * Deny's partner on every approval card (Claude Desktop's split button): the primary choice with its key, and a
 * chevron that opens the card's other choices. With `human`, the primary and the chevron take a person's clicks
 * only, and so the menu, which only the chevron opens, is a person's too.
 */
export function AllowSplit({
  label,
  kbd,
  onAllow,
  menu,
  human = false,
  autoFocus = false,
  holding = false,
  title,
}: {
  label: string;
  /** The primary button's tooltip */
  title?: string;
  kbd?: string;
  onAllow: () => void;
  menu?: React.ReactNode;
  human?: boolean;
  autoFocus?: boolean;
  holding?: boolean;
}) {
  const opts = useAnchor();
  const click = (fn: () => void) => (human ? humanClick(fn) : fn);
  return (
    <>
      <div className="ap-split">
        <button className={`ap-btn allow ${holding ? 'holding' : ''}`} title={title} autoFocus={autoFocus} onClick={click(onAllow)}>
          {label} {kbd && <kbd>{kbd}</kbd>}
        </button>
        {menu && (
          <button ref={opts.ref} className="ap-btn allow chevron" aria-label="Approval options" onClick={click(opts.toggle)}>
            <ChevronDown size={14} />
          </button>
        )}
      </div>
      {menu && (
        <Menu anchor={opts.anchor} open={opts.open} onClose={opts.close} placement="top-end" width={250}>
          {menu}
        </Menu>
      )}
    </>
  );
}

/** Labeled values (what a browser request is about), in place of raw JSON. */
export function Rows({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="approval-rows">
      {withKeys(rows, (r) => r.label).map(({ key, item: r }) => (
        <div key={key}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export type ElicitationRequest = PendingRequest<'mcpServer/elicitation/request'>;
/** The elicitation cards' reading of every MCP elicitation: each Codex mode, and Claude's. */
export type ElicitationView = { serverName?: string; message?: string; mode?: string; url?: string | null; requestedSchema?: unknown };
