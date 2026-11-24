// The composer's usage ring opens one popover with the chat's context and the plan limits of the login its next message uses.
import { useId, useRef } from 'react';
import { identityKey } from '../../../shared/identityKey.mjs';
import { MOPILOT_PLAN } from '../../harness/accounts';
import type { HarnessKind } from '../../harness/adapter';
import { currentFamily, firstTierOf } from '../../harness/family';
import { firstTierKind } from '../../harness/ownership';
import { tightestWindow } from '../../harness/usageWindows';
import { contextLevel, contextShare, contextTokens } from '../../lib/contextFormat';
import { contextPercent, contextTip, type ContextReading } from '../../store/contextUsage';
import { useStore } from '../../store/core';
import { useChatAccountView } from '../../session/harness/chatAccountView';
import { useSessionField } from '../../store/session/useSession';
import { useChatContext } from '../../session/useChatContext';
import { useContextOwner, useContextSnapshot } from '../../session/useContextSnapshot';
import { Popover, Tooltip, useAnchor } from '../ui/Popover';
import { useFocusWhileOpen } from '../ui/MenuList';
import { LazyContextPanel } from '../context/LazyContextPanel';
import {
  ComposerPlanLimits,
  type ComposerPlanUsage,
  refreshComposerUsage,
  planWindowName,
  windowUsed,
  limitLevel,
} from './ComposerPlanLimits';

const R = 6;
const CIRCUMFERENCE = 2 * Math.PI * R;

export function ContextRing({
  threadId,
  selection,
  momo = false,
}: {
  threadId: string | null;
  selection: HarnessKind | null;
  momo?: boolean;
}) {
  const context = useChatContext(threadId, "read a chat's context use for the composer");
  const auto = useContextSnapshot(threadId, "read a chat's context use for the composer")?.autoCompact;
  const owner = useContextOwner(threadId)?.owner ?? null;
  // Plan limits belong to the harness the picker beside the ring names: the next message spends its login's plan, also
  // before a switched chat's session changes. Context stays the open session's. Until the picker resolves, the session's.
  const servingHarness = useStore((s) =>
    momo ? null : selection || !threadId ? firstTierKind(selection) : firstTierOf(currentFamily(s.segments[threadId], threadId)),
  );
  // a switch that waits for the next message may name the login it moves the chat to
  const pending = useSessionField(threadId, (s) => s.pendingSwitch);
  const view = useChatAccountView(servingHarness ?? 'codex', threadId, pending?.harness === servingHarness ? pending.account : null);
  const account = servingHarness ? view.account : null;
  const plan =
    servingHarness &&
    account?.kind !== 'apiKey' &&
    account?.plan !== MOPILOT_PLAN &&
    (view.windows.length || (account?.kind === 'subscription' && account.status === 'ok'))
      ? { ...view, harness: servingHarness }
      : null;
  if (!context && !plan) return null;
  return (
    <UsageRing
      key={identityKey(owner, selection, servingHarness, account?.id ?? null, account?.email ?? null, account?.kind ?? null)}
      threadId={threadId}
      context={context}
      autoThreshold={auto?.enabled ? auto.threshold : null}
      plan={plan}
    />
  );
}

function UsageRing({
  threadId,
  context,
  autoThreshold,
  plan,
}: {
  threadId: string | null;
  context: ContextReading | null;
  autoThreshold: number | null;
  plan: ComposerPlanUsage | null;
}) {
  const { ref, anchor, open, close, toggle } = useAnchor<HTMLButtonElement>();
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useFocusWhileOpen(panel, open);
  const planWindow = plan && tightestWindow(plan.windows);
  const planUsed = planWindow && windowUsed(planWindow);
  const planLabel =
    plan &&
    (planWindow && planUsed !== null ? `Plan usage: ${planWindowName(plan.harness, planWindow.label)}, ${planUsed}% used` : 'Plan usage');
  const contextUsed = context ? contextPercent(context) : 0;
  const shown = Math.min(100, planUsed ?? contextUsed);
  const tip = context && contextTip(context, autoThreshold);
  const contextLabel =
    context &&
    `Context: ${contextShare(context.used, context.window)} used, ${contextTokens(context.used)} of ${contextTokens(context.window)} tokens`;
  const contextTone = contextLevel(contextUsed);
  const level = planUsed === null ? contextTone : limitLevel(planUsed);
  const ring = (
    <button
      ref={ref}
      type="button"
      className="composer-icon-btn context-ring"
      data-level={level}
      aria-label={[contextLabel, planLabel].filter(Boolean).join('. ')}
      data-usage={planUsed === null ? undefined : 'plan'}
      aria-haspopup="dialog"
      aria-controls={open ? panelId : undefined}
      aria-expanded={open}
      onClick={() => {
        if (!open && plan) refreshComposerUsage(plan.harness, 'surface');
        toggle();
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="context-ring-track" cx="8" cy="8" r={R} />
        {shown > 0 && (
          <circle
            className="context-ring-fill"
            cx="8"
            cy="8"
            r={R}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - shown / 100)}
            transform="rotate(-90 8 8)"
          />
        )}
      </svg>
    </button>
  );
  return (
    <>
      {/* no tooltip while the panel is open: it would cover the panel the ring just opened */}
      <Tooltip
        disabled={open}
        placement="top"
        label={
          <span className="context-tip" data-level={contextTone}>
            {tip && (
              <>
                <span>
                  <span className="context-tip-used">{tip.used}</span>
                  <span className="context-tip-sub"> · {tip.tokens}</span>
                </span>
                <span className="context-tip-sub">{tip.hint}</span>
              </>
            )}
            {planLabel && <span>{planLabel}</span>}
          </span>
        }
      >
        {ring}
      </Tooltip>
      <Popover anchor={anchor} open={open} onClose={close} placement="top-end" className="ctx-popover">
        {open && (
          <div id={panelId} ref={panel} tabIndex={-1} role="dialog" aria-label="Usage">
            <UsagePanel threadId={threadId} plan={plan} onDone={close} />
          </div>
        )}
      </Popover>
    </>
  );
}

function UsagePanel({ threadId, plan, onDone }: { threadId: string | null; plan: ComposerPlanUsage | null; onDone: () => void }) {
  const limits = plan && <ComposerPlanLimits usage={plan} threadId={threadId} onDone={onDone} />;
  return threadId ? <LazyContextPanel threadId={threadId} onDone={onDone} compact planLimits={limits} /> : limits;
}
