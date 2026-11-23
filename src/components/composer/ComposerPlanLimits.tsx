// Account limits inside the composer's usage popover, with reset times, refresh and a link to the Usage pane.
import { accountName, accountStatusText } from '../../harness/accounts';
import { HARNESS_LABEL, type HarnessId, type UsageReason, type UsageWindow } from '../../harness/types';
import { LOW_LEFT } from '../../harness/accountMenuUsage';
import { percentLeft, planWindowName, RESET_SINCE_READ, resetWhen, usedNow } from '../../harness/usageWindows';
import { withKeys } from '../../lib/listKeys';
import { noteIgnored } from '../../lib/ignored';
import type { useChatAccountView } from '../../session/harness/chatAccountView';
import { refreshPlanUsage } from '../../session/harness/planUsage';
import { openSessionPane } from '../../store/outputs/pane';
import { RefreshCw } from '../ui/icons';

export type ComposerPlanUsage = Pick<ReturnType<typeof useChatAccountView>, 'windows' | 'account' | 'plan' | 'at'> & {
  harness: HarnessId;
};

export function refreshComposerUsage(harness: HarnessId, reason: UsageReason) {
  void refreshPlanUsage(harness, reason).catch((e) => noteIgnored(`refresh ${HARNESS_LABEL[harness]}'s plan usage for the composer`, e));
}

export { planWindowName };

export function windowUsed(window: UsageWindow): number | null {
  const used = usedNow(window);
  return used === null ? null : 100 - percentLeft(used);
}

export function limitLevel(used: number): 'ok' | 'warn' | 'full' {
  return used >= 100 ? 'full' : 100 - used < LOW_LEFT ? 'warn' : 'ok';
}

function PlanWindow({ harness, window }: { harness: HarnessId; window: UsageWindow }) {
  const name = planWindowName(harness, window.label);
  const used = windowUsed(window);
  const reset = used === null ? RESET_SINCE_READ : resetWhen(window);
  return (
    <div className="limit-row" data-level={used === null ? undefined : limitLevel(used)}>
      <span>{name}</span>
      <span className="usage-limit-value">{used === null ? '—' : `${used}% used`}</span>
      <div
        className="limit-row-bar"
        {...(used === null
          ? { 'aria-hidden': true }
          : { role: 'meter', 'aria-label': name, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': used })}
      >
        {used !== null && <i style={{ width: `${used}%` }} />}
      </div>
      {reset && <span className="limit-row-reset">{reset}</span>}
    </div>
  );
}

function readingAge(at: number | null): string | null {
  if (!at) return null;
  const mins = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  return mins < 1 ? 'Updated just now' : mins < 60 ? `Updated ${mins}m ago` : `Updated ${Math.floor(mins / 60)}h ago`;
}

export function ComposerPlanLimits({ usage, threadId, onDone }: { usage: ComposerPlanUsage; threadId: string | null; onDone: () => void }) {
  const { harness, windows, account, plan, at } = usage;
  const identity = [account && accountName(account), plan].filter(Boolean).join(' · ');
  const age = readingAge(at);
  return (
    <section className="ctx-limits" aria-label="Usage limits">
      <div className="ctx-limits-head">
        <span className="ctx-title">{HARNESS_LABEL[harness]} usage limits</span>
        <button
          type="button"
          className="btn-pill icon"
          title="Refresh usage"
          aria-label="Refresh usage"
          onClick={() => refreshComposerUsage(harness, 'now')}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {identity && <span className="ctx-sub">{identity}</span>}
      {windows.length ? (
        <div className="composer-plan-windows">
          {withKeys(windows, (window) => window.label).map(({ key, item }) => (
            <PlanWindow key={key} harness={harness} window={item} />
          ))}
        </div>
      ) : (
        account && (
          <span className="ctx-sub" role="status">
            {accountStatusText(account).text}
          </span>
        )
      )}
      {(age || threadId) && (
        <div className="ctx-limits-foot">
          {age && <span className="ctx-sub">{age}</span>}
          {threadId && (
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                onDone();
                openSessionPane(threadId, 'usage');
              }}
            >
              All usage
            </button>
          )}
        </div>
      )}
    </section>
  );
}
