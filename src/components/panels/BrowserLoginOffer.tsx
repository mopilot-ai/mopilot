// The "Save password?" bar under the browser pane's toolbar: main offers it after the user signs in on the page with a password MoPilot doesn't have (loginAssist.cjs); Save, Never (for this site) or Not now (its close) go back to main, which holds the password. It also tells the user when the in-page dropdown couldn't fill a login.
import { useEffect, useRef, useState } from 'react';
import { native, type LoginAssistEvent } from '../../lib/native';
import { toast } from '../../store/core';
import { KeyRound } from '../ui/icons';
import { PaneNotice } from './browserPanel/PaneNotice';
import { FILL_FAILED, LOGINS_CHANGED } from './BrowserLoginKey';

type Offer = Extract<LoginAssistEvent, { kind: 'offer' }>;

/** The offers without page `pageId`'s, when it is still `offerId` (a newer one on the page stays). */
function withoutOffer(offers: Record<number, Offer>, pageId: number, offerId: string): Record<number, Offer> {
  if (offers[pageId]?.offerId !== offerId) return offers;
  const { [pageId]: _done, ...rest } = offers;
  return rest;
}

/** @param pageId the pane tab's webContents id now, or null while it has none */
export function BrowserLoginOffer({ pageId }: { pageId: () => number | null }) {
  // per page: an offer for a tab in the background shows when the pane comes back to it
  const [offers, setOffers] = useState<Record<number, Offer>>({});
  // the pane passes a new function each render; the subscription reads the latest
  const page = useRef(pageId);
  page.current = pageId;
  // the offers as they are when an answer comes back
  const latest = useRef(offers);
  latest.current = offers;
  useEffect(
    () =>
      native.browser.onLoginAssist((e) => {
        if (e.kind === 'offer') setOffers((o) => ({ ...o, [e.pageId]: e }));
        else if (e.kind === 'offer_gone') setOffers((o) => withoutOffer(o, e.pageId, e.offerId));
        else if (e.pageId === page.current()) toast(FILL_FAILED[e.status] ?? FILL_FAILED.failed, 'error');
      }),
    [],
  );
  const now = pageId();
  const offer = now == null ? undefined : offers[now];
  if (!offer) return null;
  const answer = async (choice: 'save' | 'never' | 'dismiss') => {
    setOffers((o) => withoutOffer(o, offer.pageId, offer.offerId));
    // main answers only the offer this bar showed: a newer one the page made since stays offered, and this one is gone
    const r = await native.browser.answerLoginOffer(offer.pageId, choice, offer.offerId).catch(() => 'failed' as const);
    if (r === 'saved') {
      toast(offer.update ? 'Password updated' : 'Password saved');
      window.dispatchEvent(new Event(LOGINS_CHANGED));
    } else if (r === 'failed') toast(choice === 'never' ? "Couldn't remember this choice" : "Couldn't save the password", 'error');
    // gone because a newer sign-in replaced it: that one is on the bar now, so nothing is said
    else if (r === 'gone' && choice !== 'dismiss' && !latest.current[offer.pageId])
      toast('That offer expired. Sign in again to save the password.', 'error');
  };
  return (
    // a band in the layout, not a dialog: an overlay role would hide the page under it (browserView.ts)
    <PaneNotice
      className="browser-login-offer"
      role="group"
      label={offer.update ? 'Update password' : 'Save password'}
      closeLabel="Not now"
      onClose={() => void answer('dismiss')}
    >
      <KeyRound size={15} />
      <span className="browser-login-offer-text">
        {offer.update ? 'Update the saved password' : 'Save password'} for <b>{offer.host}</b>
        {offer.username ? (
          <>
            {' '}
            as <b>{offer.username}</b>
          </>
        ) : null}
        ?
      </span>
      <div className="browser-notice-actions">
        <button type="button" className="primary" onClick={() => void answer('save')}>
          {offer.update ? 'Update' : 'Save'}
        </button>
        {!offer.update && (
          <button type="button" onClick={() => void answer('never')}>
            Never for this site
          </button>
        )}
      </div>
    </PaneNotice>
  );
}
