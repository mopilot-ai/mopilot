// Usage meters with one look everywhere: what each quota window has left, as "x% left", from the harness
// pickers and Settings cards to the account rows and the harness page's account card.
import { LOW_LEFT } from '../../harness/accountMenuUsage';
import type { UsageWindow } from '../../harness/types';
import { percentLeft, RESET_SINCE_READ, resetWhen, usedNow } from '../../harness/usageWindows';
import { withKeys } from '../../lib/listKeys';

const fillTone = (left: number) => (left <= 0 ? 'out' : left < LOW_LEFT ? 'low' : '');
/** What is left of a window, or null once its reset passed since the reading (not known, never full). */
const leftNow = (w: UsageWindow) => {
  const used = usedNow(w);
  return used == null ? null : percentLeft(used);
};

/**
 * Each window's meter. `inline`: "5h ▓▓▓ 82% left" side by side (at most two); `compact`: the same with the
 * percent alone, for the pickers; `detail`: name, percent left, a full-width bar and the reset time, indented under an
 * account; `rows`: flush rows of name and reset time, a thin bar and "x% left", for the context panel.
 */
export function LimitMeters({
  windows,
  variant = 'inline',
}: {
  windows: readonly UsageWindow[];
  variant?: 'inline' | 'compact' | 'detail' | 'rows';
}) {
  if (!windows.length) return null;
  const keyed = withKeys(windows, (w) => w.label);
  if (variant === 'rows')
    return (
      <div className="limit-rows">
        {keyed.map(({ key, item: w }) => {
          const left = leftNow(w);
          const reset = left == null ? RESET_SINCE_READ : resetWhen(w);
          return (
            <div key={key} className="limit-row">
              <div className="limit-row-name">
                <span>{w.label}</span>
                {reset && <span className="limit-row-reset">{reset}</span>}
              </div>
              <div className="limit-row-bar">{left != null && <i className={fillTone(left)} style={{ width: `${left}%` }} />}</div>
              <span className="limit-row-left">{left == null ? '—' : `${left}% left`}</span>
            </div>
          );
        })}
      </div>
    );
  if (variant === 'detail')
    return (
      <div className="acct-limits">
        {keyed.map(({ key, item: w }) => {
          const left = leftNow(w);
          const reset = left == null ? RESET_SINCE_READ : resetWhen(w);
          return (
            <div key={key} className="acct-limit">
              <div className="limit-meta">
                <span>{w.label}</span>
                <span className="limit-left">{left == null ? '—' : `${left}% left`}</span>
              </div>
              <div className="limit-bar">
                {left != null && <div className={`limit-fill ${fillTone(left)}`} style={{ width: `${left}%` }} />}
              </div>
              {reset && <div className="limit-reset">{reset}</div>}
            </div>
          );
        })}
      </div>
    );
  return (
    <div className={`hp-meters ${variant === 'compact' ? 'compact' : ''}`}>
      {keyed.slice(0, 2).map(({ key, item: w }) => {
        const left = leftNow(w);
        return (
          <span key={key} className="hp-meter" title={(left == null ? RESET_SINCE_READ : resetWhen(w)) ?? undefined}>
            <span>{w.label}</span>
            <span className="hp-bar">{left != null && <i style={{ width: `${left}%` }} className={fillTone(left)} />}</span>
            <span>{left == null ? '—' : variant === 'compact' ? `${left}%` : `${left}% left`}</span>
          </span>
        );
      })}
    </div>
  );
}
