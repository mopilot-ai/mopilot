// The browser pane's Annotate mode: injecting the overlay, the notes bar for each mark and attaching them to a composer.

import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp } from '../ui/icons';
import { toast } from '../../store/core';
import { attachToComposer } from '../../session/composerAttach';
import { native } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import { annotateScripts, readSignal, type MarkSummary } from '../../lib/annotateOverlay';
import { cropRect, pageAnnotationAttachment, NOTE_LIMIT, type RawPage } from '../../lib/pageAnnotations';
import { useEffectOn } from '../../lib/effects';
import { busyField, imeComposing } from '../../lib/focus';
import { pluralize } from '../../lib/format';

/**
 * Runs an overlay script in the pane tab's isolated Annotate world (main, IAB-13); a synchronous
 * throw (guest not attached) rejects too. The page is a <webview> or a main-owned view's handle
 * (lib/browserView.ts), which fire the same console-message and did-navigate events.
 */
interface AnnotationWebview {
  addEventListener(type: string, fn: (e: Event) => void): void;
  removeEventListener(type: string, fn: (e: Event) => void): void;
  getWebContentsId(): number;
  getZoomFactor(): number;
}
const run = <T = unknown>(wv: AnnotationWebview, script: string): Promise<T> =>
  Promise.resolve().then(() => native.browser.annotate(wv.getWebContentsId(), script) as Promise<T>);

/**
 * The browser pane in Annotate mode (IAB-06). Mounting injects the overlay into the page; the page is
 * not interacted with until the bar unmounts, which removes the overlay and its marks. Every click or
 * drag in the page adds a mark. The notes are typed here, one per mark, and never enter the page
 * (IAB-13): a click on a mark's number in the page focuses its note, and × (in the page or here)
 * removes the mark. "Add to chat" captures the marked region and adds one chip for this page to the
 * pane chat's composer. Escape (in the page or the pane) leaves, but asks first when a mark has a
 * note ("Discard N marks?"; a second Escape discards); Cancel, the toolbar toggle and a main-frame
 * navigation leave at once.
 *
 * IAB-14: the bar floats over the top of the page (BrowserPanel renders it inside the page's stage,
 * absolutely positioned), so the page never moves while annotating: toggling Annotate or adding a
 * mark leaves the <webview>'s size and position as they were (a main-owned view, drawn above the
 * window, is laid out below the bar instead). The hint and actions stay fixed; the
 * marks scroll in a list capped at about four rows, and the chevron folds the list away to uncover
 * the marks under it (a click on a mark's number in the page opens it again to focus that note).
 */
export function AnnotateBar({
  webview,
  threadId,
  onExit,
}: {
  webview: RefObject<AnnotationWebview | null>;
  threadId: string | null;
  onExit: () => void;
}) {
  const [marks, setMarks] = useState<MarkSummary[]>([]);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const list = useRef<HTMLOListElement>(null);
  const listId = useId();
  const folded = useRef(false);
  folded.current = collapsed;
  // the note to focus once the folded list opens again
  const pending = useRef(0);
  const count = useRef(0);
  const signal = useRef(`mopilot-annotate:${crypto.randomUUID()}:`).current;
  const exit = useRef(onExit);
  exit.current = onExit;
  const leave = () => exit.current();
  const noted = marks.some((m) => notes[m.id]?.trim());
  // Escape: leave, unless notes would be lost and this is the first Escape
  const escape = useRef(leave);
  escape.current = () => (noted && !confirming ? setConfirming(true) : leave());

  // the overlay goes in once, on mount, and out on unmount; its listeners read the latest state through refs
  useEffectOn([webview, signal], () => {
    const wv = webview.current!;
    const onConsole = (event: Event) => {
      const e = event as Event & { message: string };
      const s = readSignal(e.message, signal);
      if (s?.type === 'marks') {
        setMarks(s.marks);
        setConfirming(false);
      } else if (s?.type === 'select') {
        setSelected(s.id);
        const input = inputs.current.get(s.id);
        if (input) input.focus();
        else if (folded.current) {
          pending.current = s.id;
          setCollapsed(false);
        }
      } else if (s) escape.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !imeComposing(e) && (e.target as Element | null)?.closest?.('.browser-pane')) escape.current();
    };
    wv.addEventListener('console-message', onConsole);
    wv.addEventListener('did-navigate', leave);
    window.addEventListener('keydown', onKey);
    run(wv, annotateScripts.install(signal)).catch(() => {
      toast("Couldn't annotate this page. Reload it and try again.", 'error');
      leave();
    });
    return () => {
      wv.removeEventListener('console-message', onConsole);
      wv.removeEventListener('did-navigate', leave);
      window.removeEventListener('keydown', onKey);
      // navigation may already have removed the isolated overlay
      run(wv, annotateScripts.destroy()).catch((e) => noteIgnored('remove the page annotation overlay', e));
    };
  });

  // a folded list opened by a click on a mark's number: focus that note now that it is rendered
  useLayoutEffect(() => {
    if (collapsed || !pending.current) return;
    inputs.current.get(pending.current)?.focus();
    pending.current = 0;
  }, [collapsed]);
  // a new mark scrolls the capped list to its row; with no marks left, the next ones show again
  useLayoutEffect(() => {
    if (marks.length > count.current && list.current) list.current.scrollTop = list.current.scrollHeight;
    if (!marks.length) setCollapsed(false);
    count.current = marks.length;
  }, [marks.length]);

  const page = (script: string) =>
    run(webview.current!, script).catch(() => {
      toast("Couldn't update the annotations. Try again.", 'error');
    });
  const add = async () => {
    const wv = webview.current!;
    setBusy(true);
    try {
      const raw: RawPage | null = await run<RawPage | null>(wv!, annotateScripts.collect());
      if (!raw?.marks.length) {
        setMarks([]);
        return;
      }
      // the notes join the marks here, outside the page
      const withNotes: RawPage = { ...raw, marks: raw.marks.map((m) => ({ ...m, note: (m.id && notes[m.id]) || '' })) };
      await run(wv!, annotateScripts.capture(true));
      let image: string | null;
      try {
        image = await native.browser.captureRegion(wv!.getWebContentsId(), cropRect(withNotes, wv!.getZoomFactor()));
      } finally {
        // restoring controls is best effort after capture; the add operation reports its result
        await run(wv!, annotateScripts.capture(false)).catch((e) => noteIgnored('show the annotation controls again after a capture', e));
      }
      const path = image ? await native.fs.saveTempImage(image) : null;
      if (!path) throw new Error('no screenshot');
      if (attachToComposer(threadId, pageAnnotationAttachment(withNotes, { path, previewUrl: image! })) === false) return;
      toast(`Added ${pluralize(withNotes.marks.length, 'mark')} to the chat`, 'success');
      leave();
    } catch {
      toast("Couldn't add the annotations to the chat. Try again.", 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="browser-annotate-bar" role="toolbar" aria-label="Annotate" data-collapsed={collapsed}>
      <div className="browser-annotate-head">
        {confirming ? (
          <>
            <span
              className="browser-annotate-text"
              role="alert"
            >{`Discard ${pluralize(marks.length, 'mark')}? Your notes will be lost.`}</span>
            <div className="browser-notice-actions">
              <button onClick={leave}>Discard</button>
              <button onClick={() => setConfirming(false)}>Keep editing</button>
            </div>
          </>
        ) : (
          <>
            <span className="browser-annotate-text">
              {marks.length
                ? `${pluralize(marks.length, 'mark')}. Click or drag to add more. Click a mark's number to edit its note, × to remove it.`
                : 'Click an element or drag a region to mark it. Esc exits.'}
            </span>
            <div className="browser-notice-actions">
              {marks.length > 0 && (
                <button disabled={busy} onClick={() => page(annotateScripts.clear())}>
                  Clear
                </button>
              )}
              <button className="primary" disabled={busy || !marks.length} onClick={add}>
                {busy ? 'Adding…' : 'Add to chat'}
              </button>
              <button disabled={busy} onClick={leave}>
                Cancel
              </button>
            </div>
          </>
        )}
        {marks.length > 0 && (
          <button
            className="browser-annotate-fold"
            aria-expanded={!collapsed}
            aria-controls={listId}
            aria-label={collapsed ? 'Show marks' : 'Hide marks'}
            title={collapsed ? 'Show the marks list' : 'Hide the marks list to see the page under it'}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        )}
      </div>
      {marks.length > 0 && !collapsed && (
        <ol ref={list} id={listId} className="browser-annotate-marks">
          {marks.map((m) => (
            <li key={m.id} data-selected={m.id === selected}>
              <span className="browser-annotate-badge" aria-hidden="true">
                {m.n}
              </span>
              <span className="browser-annotate-kind">{m.kind === 'element' ? `<${m.label}>` : 'Region'}</span>
              <input
                ref={(el) => {
                  if (el) inputs.current.set(m.id, el);
                  else inputs.current.delete(m.id);
                }}
                value={notes[m.id] ?? ''}
                maxLength={NOTE_LIMIT}
                placeholder="Add a note (optional)"
                aria-label={`Note for mark ${m.n}`}
                {...busyField(busy)}
                onChange={(e) => {
                  const v = e.target.value;
                  setNotes((n) => ({ ...n, [m.id]: v }));
                  setConfirming(false);
                }}
                onFocus={() => {
                  setSelected(m.id);
                  void page(annotateScripts.select(m.id));
                }}
              />
              <button
                className="browser-annotate-remove"
                disabled={busy}
                aria-label={`Remove mark ${m.n}`}
                title="Remove this mark"
                onClick={() => page(annotateScripts.unmark(m.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
