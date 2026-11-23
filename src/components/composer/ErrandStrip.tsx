// The line above a chat's composer while its ordinary messages are allowed on a site for its errand (errandGrants.cjs): which site,
// in which browser, and Revoke, after which messages there ask again. Offers, order changes and personal details always ask.
import { useEffect, useState } from 'react';
import { native, type ErrandAllowance } from '../../lib/native';
import { toast } from '../../store/core';
import { userError } from '../../../shared/userError.mjs';

/** The site as the line names it: its host, without the scheme. */
const hostOf = (site: string) => site.replace(/^[a-z]+:\/\//i, '');

export function ErrandStrip({ threadId }: { threadId: string }) {
  const [errands, setErrands] = useState<ErrandAllowance[]>([]);
  useEffect(() => {
    let live = true;
    // a push that lands before the first read is newer than it: the read only fills an empty list
    let pushed = false;
    const off = native.browser.onErrands(({ chatId, errands: next }) => {
      if (chatId !== threadId) return;
      pushed = true;
      setErrands(next);
    });
    native.browser.errands(threadId).then(
      (list) => live && !pushed && setErrands(list),
      (e) => live && toast(userError(e), 'error'),
    );
    return () => {
      live = false;
      off();
    };
  }, [threadId]);
  if (!errands.length) return null;
  return (
    <>
      {errands.map((a) => (
        <div key={`${a.browser} ${a.site}`} className="switch-chip routing-chip" data-errand-strip>
          <span>
            Messages on {hostOf(a.site)} allowed for this errand{a.browser === 'chrome' ? ' (Chrome)' : ''}
          </span>
          <button
            className="btn-pill"
            onClick={() => void native.browser.revokeErrand(threadId, a.site, a.browser).catch((e) => toast(userError(e), 'error'))}
          >
            Revoke
          </button>
        </div>
      ))}
    </>
  );
}
