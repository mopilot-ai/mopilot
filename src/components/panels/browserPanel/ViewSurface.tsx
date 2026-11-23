// Main-owned browser view binding, event subscription and bounds reporting.
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { useEffectOn } from '../../../lib/effects';
import { native } from '../../../lib/native';
import { noteIgnored } from '../../../lib/ignored';
import { ViewHandle, measure, sameRect, OVERLAY_SELECTOR, BAND_SELECTOR, type Rect } from '../../../lib/browserView';
import { visiblePoll } from '../../../lib/visiblePoll';
import type { WebviewElement } from '../../../session/useBrowserShortcuts';

export type { WebviewElement };

/** Electron's did-fail-load event on a <webview>. */
export interface DidFailLoadEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

export function ViewSurface({
  handleRef,
  paneId,
  url,
  partition,
  chatId,
  chat,
  tabKey,
  shown,
  onClosed,
}: {
  handleRef: MutableRefObject<WebviewElement | null>;
  paneId: string;
  url: string;
  partition: string;
  chatId: string | null;
  /** the chat whose pane this is: a user's page asks for permissions on its card */
  chat: string | null;
  tabKey: string | null;
  shown: boolean;
  onClosed: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [handle] = useState(() => new ViewHandle(native.browser.view));
  const [id, setId] = useState<number | null>(null);
  const closed = useRef(onClosed);
  closed.current = onClosed;
  // read when the view binds, not a reason to bind again
  const chatNow = useRef(chat);
  chatNow.current = chat;
  // the panel's page effects run after this, with the handle in place
  useLayoutEffect(() => {
    handleRef.current = handle;
    return () => {
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [handle, handleRef]);
  // binds once: the panel mounts a new surface (keyed by its page) for another page; a later chat, tab key or
  // address of this one is main's to follow (attach, the page's own navigation)
  useEffectOn([], () => {
    let live = true;
    const off = native.browser.view.onEvent((e) => {
      if (e.id !== handle.id) return;
      if (e.type === 'closed') closed.current();
      else {
        // A native child view's focus cannot bubble through the renderer DOM on its own.
        if (e.type === 'focus') stage.current?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        handle.receive(e);
      }
    });
    native.browser.view.bind(paneId, { chatId, chat: chatNow.current, tabKey, url, partition }).then(
      (r) => {
        if (!live || !r) return;
        if ('closed' in r) return closed.current();
        handle.bound(r.id, r.state);
        setId(r.id);
      },
      () => {
        /* main refused the page: the stage stays empty */
      },
    );
    return () => {
      live = false;
      off();
    };
  });
  useEffect(() => {
    if (id == null) return;
    let last: Rect | null | undefined;
    let frame = 0;
    let pending = false;
    const report = () => {
      const rect = shown && stage.current ? measure(stage.current) : null;
      if (last !== undefined && sameRect(rect, last)) return;
      last = rect;
      // the page went: its closed event takes the tab away
      native.browser.view.bounds(id, rect).catch((e) => noteIgnored("place a browser pane page's view", e));
    };
    // at most one measure per frame
    const schedule = () => {
      if (pending) return;
      pending = true;
      frame = requestAnimationFrame(() => {
        pending = false;
        report();
      });
    };
    report();
    if (!shown) return;
    // the rect moves with layout: the stage and every ancestor resizing (the pane's width), transitions ending, zoom
    // and scrolling; menus, dialogs and bands are portals that resize nothing, so the body's direct children (not its
    // subtree, which streamed text churns) and those overlays' own attributes are watched; a stage that moves
    // without resizing (a sidebar sliding, a pane spring) is caught by a re-measure while the window is visible.
    const resize = new ResizeObserver(schedule);
    for (let el: Element | null = stage.current; el; el = el.parentElement) resize.observe(el);
    const overlays = new MutationObserver((records) => {
      schedule();
      if (records.some((r) => r.target === document.body)) watchOverlays();
    });
    function watchOverlays() {
      for (const el of document.querySelectorAll(`${OVERLAY_SELECTOR}, ${BAND_SELECTOR}`))
        overlays.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    }
    overlays.observe(document.body, { childList: true });
    watchOverlays();
    const stopPoll = visiblePoll(`browser-view-bounds:${id}`, 250, report, { wake: false });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('transitionend', schedule, true);
    document.addEventListener('animationend', schedule, true);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      overlays.disconnect();
      stopPoll();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('transitionend', schedule, true);
      document.removeEventListener('animationend', schedule, true);
      document.removeEventListener('visibilitychange', schedule);
      // the page went already
      native.browser.view.bounds(id, null).catch((e) => noteIgnored("hide a browser pane page's view", e));
    };
  }, [id, shown]);
  return <div ref={stage} className="browser-view" data-view={id ?? undefined} />;
}
