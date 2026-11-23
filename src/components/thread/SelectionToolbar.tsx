// The toolbar on a text selection in a message: quote it into the composer as an annotation, with an optional comment.

import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { openSideChat } from '../../store/actions';
import { toastFailure, useStore } from '../../store/core';
import type { Attachment } from '../../store/types';
import { selectionRange, selectionSource } from '../../lib/selectionAnchor';
import { annotationAttachment } from '../../lib/annotations';
import { attachToComposer, deleteComposerAnnotation, retainComposerAnnotation } from '../../session/composerAttach';
import { AnnotationComment } from '../composer/AnnotationComment';
import { messageBodyRange } from '../../lib/messageSelection';
import { dispatchComposerFocus } from '../../lib/composerEvents';
import { withKeys } from '../../lib/listKeys';
import { imeComposing } from '../../lib/focus';
import { SelectionPopover } from './SelectionPopover';

interface Anchor {
  text: string;
  rect: DOMRect;
  range: Range;
  source?: Attachment['source'];
}

function intersect(r: DOMRect, b: DOMRect) {
  const left = Math.max(r.left, b.left, 0);
  const top = Math.max(r.top, b.top, 0);
  const right = Math.min(r.right, b.right, window.innerWidth);
  const bottom = Math.min(r.bottom, b.bottom, window.innerHeight);
  return left >= right || top >= bottom ? null : new DOMRect(left, top, right - left, bottom - top);
}

/** A selection within one message body, anchored to its first line that is still scrolled into view. */
function readAnchor(container: HTMLElement): Anchor | null {
  const s = window.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return null;
  // the selection's own text leaves out what cannot be selected, so a clamp past it keeps that text
  const own = s.toString();
  const selected = messageBodyRange(s.getRangeAt(0), own);
  if (!selected || !container.contains(selected.commonAncestorContainer)) return null;
  const text = own.trim();
  if (!text) return null;
  const range = selected.cloneRange();
  for (const r of range.getClientRects()) {
    const rect = intersect(r, container.getBoundingClientRect());
    if (rect) return { text, rect, range, source: selectionSource(range, text) };
  }
  return null;
}

/**
 * Watch the transcript for anything that moves what was read out of it: its own size, its content (a reply that
 * grows word by word, a turn that swaps with a placeholder), the page scrolling under it, and the window resizing.
 * `read` runs at once and again on every change, so nothing derived from the selection's line boxes is left
 * standing on a single stale read.
 */
export function watchTranscript(container: HTMLElement, read: () => void): () => void {
  read();
  const resize = new ResizeObserver(read);
  resize.observe(container);
  const mutation = new MutationObserver(read);
  mutation.observe(container, { childList: true, characterData: true, subtree: true });
  window.addEventListener('resize', read);
  window.addEventListener('scroll', read, true);
  return () => {
    resize.disconnect();
    mutation.disconnect();
    window.removeEventListener('resize', read);
    window.removeEventListener('scroll', read, true);
  };
}

/** What a read found, so a read that finds the same selection in the same place can keep the bar it placed. */
const anchorKey = (a: Anchor) => JSON.stringify([a.source, a.text, a.rect.top, a.rect.left, a.rect.width, a.rect.height]);

interface Marker {
  id: string;
  index: number;
  rect: DOMRect;
}
interface Pending {
  attachment: Attachment;
  rect: DOMRect;
  range?: Range;
}

/** Selected text becomes a draft annotation immediately; its optional comment edits that attachment. */
export function SelectionToolbar({
  containerRef,
  threadId,
  inPane = false,
}: {
  containerRef: RefObject<HTMLElement | null>;
  threadId: string;
  inPane?: boolean;
}) {
  const attachments = useStore((s) => s.drafts[threadId]?.attachments);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [highlights, setHighlights] = useState<DOMRect[]>([]);
  const [commentVisible, setCommentVisible] = useState(true);
  const barRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(pending);
  const savedAnnotations = useRef(new Set<string>());
  const [selecting, setSelecting] = useState(false);
  const selectingRef = useRef(false);
  const updateRef = useRef<(() => void) | null>(null);
  pendingRef.current = pending;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    let pressing = false;
    const update = () => {
      const s = window.getSelection();
      // only a change sets state: this runs inside effects and on every transcript change, and an unchanged set is a wasted commit
      const now = !!s && !s.isCollapsed && s.rangeCount > 0;
      if (now !== selectingRef.current) {
        selectingRef.current = now;
        setSelecting(now);
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = pressing || pendingRef.current ? null : readAnchor(container);
        // the transcript reports a change for every streamed word: a read that finds the same selection in the
        // same place keeps the bar it already placed
        setAnchor((previous) =>
          previous &&
          next &&
          anchorKey(previous) === anchorKey(next) &&
          previous.range.startContainer === next.range.startContainer &&
          previous.range.startOffset === next.range.startOffset &&
          previous.range.endContainer === next.range.endContainer &&
          previous.range.endOffset === next.range.endOffset
            ? previous
            : next,
        );
      });
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (barRef.current?.contains(target) || commentRef.current?.contains(target)) return;
      if (!target.closest('.annotation-marker, .tooltip')) setPending(null);
      pressing = true;
      setAnchor(null);
    };
    const onPointerUp = () => {
      pressing = false;
      update();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !imeComposing(e)) {
        window.getSelection()?.removeAllRanges();
        setPending(null);
        setAnchor(null);
      }
    };
    document.addEventListener('selectionchange', update);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('keyup', update);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('dblclick', update);
    // a selection the user still has must not depend on one frame's read: read now (the bar survives a remount
    // with text already selected) and again whenever the transcript moves under it
    // the transcript is only watched while a selection exists (the effect below); this read is the first one
    update();
    updateRef.current = update;
    return () => {
      cancelAnimationFrame(frame);
      updateRef.current = null;
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('keyup', update);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('dblclick', update);
    };
  }, [containerRef]);

  // a selection (placed or not yet in view) follows the transcript as it moves; with none, nothing observes it
  useEffect(() => {
    const container = containerRef.current;
    if (!selecting || !container) return;
    return watchTranscript(container, () => updateRef.current?.());
  }, [selecting, containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    const place = () => {
      const bounds = container.getBoundingClientRect();
      const selections = (attachments ?? []).filter((a) => a.kind === 'selection');
      // the effect runs again whenever the pending annotation changes
      const current = pending;
      for (const selection of selections) if (selection.annotationId) savedAnnotations.current.add(selection.annotationId);
      // Bridge the first render before the composer saves a new attachment, but never revive a deleted one.
      if (current && !selections.some((a) => a.annotationId === current.attachment.annotationId)) {
        if (savedAnnotations.current.has(current.attachment.annotationId!)) setPending(null);
        else selections.push(current.attachment);
      }
      const next: Marker[] = [];
      let selectedRects: DOMRect[] = [];
      selections.forEach((attachment, index) => {
        const isEditing = !!current && current.attachment.annotationId === attachment.annotationId;
        const range = selectionRange(container, attachment) ?? (isEditing && current.range);
        if (!attachment.annotationId || !range) return;
        const rects = Array.from(range.getClientRects())
          .map((r) => intersect(r, bounds))
          .filter((r): r is DOMRect => !!r);
        const last = rects.at(-1);
        if (last) next.push({ id: attachment.annotationId, index: index + 1, rect: last });
        if (isEditing) {
          selectedRects = rects;
          const first = rects[0];
          if (first && (first.top !== current.rect.top || first.left !== current.rect.left || first.width !== current.rect.width)) {
            setPending({ ...current, rect: first });
          }
        }
      });
      setMarkers(next);
      setHighlights(selectedRects);
      setCommentVisible(!current || selectedRects.length > 0);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    // annotation marks follow the transcript only while some exist; otherwise one read clears them
    const marked = !!pending || (attachments ?? []).some((a) => a.kind === 'selection');
    const stop = marked ? watchTranscript(container, schedule) : null;
    if (!marked) schedule();
    return () => {
      cancelAnimationFrame(frame);
      stop?.();
    };
  }, [attachments, pending, containerRef]);

  const finish = () => {
    setPending(null);
    window.getSelection()?.removeAllRanges();
  };
  const add = (anchor: Anchor) => {
    const attachment = annotationAttachment(anchor.text, anchor.source);
    if (attachToComposer(threadId, attachment, { focus: false }) === false) return;
    setPending({ attachment, rect: anchor.rect, range: anchor.range });
    setCommentVisible(true);
    setAnchor(null);
  };
  const editComment = (current: Pending, annotation: string) => {
    const attachment = { ...current.attachment, annotation };
    setPending({ ...current, attachment });
    window.dispatchEvent(
      new CustomEvent('composer-update-selection', { detail: { threadId, annotationId: attachment.annotationId, annotation } }),
    );
    retainComposerAnnotation(threadId, attachment.annotationId!, annotation);
  };
  const remove = (current: Pending) => {
    deleteComposerAnnotation(threadId, current.attachment.annotationId!);
    finish();
  };
  return createPortal(
    <>
      {withKeys(highlights, (r) => JSON.stringify([r.left, r.top, r.width, r.height])).map(({ key, item: rect }) => (
        <div
          key={key}
          className="annotation-selection-highlight"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      ))}
      {markers.map((marker) => (
        <button
          key={marker.id}
          type="button"
          className="annotation-marker"
          style={{
            left: Math.min(window.innerWidth - 36, Math.max(8, marker.rect.right - 14)),
            top: Math.max(containerRef.current?.getBoundingClientRect().top ?? 8, marker.rect.top - 27),
          }}
          aria-label={`Edit annotation ${marker.index}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const attachment = (attachments ?? []).find((a) => a.annotationId === marker.id) ?? pendingRef.current?.attachment;
            if (!attachment) return;
            const range = containerRef.current && selectionRange(containerRef.current, attachment);
            setAnchor(null);
            setCommentVisible(true);
            setPending({ attachment, rect: range?.getClientRects()[0] ?? marker.rect, range: range || undefined });
          }}
        >
          {marker.index}
        </button>
      ))}
      {anchor && (
        <SelectionPopover rect={anchor.rect} containerRef={containerRef} surfaceRef={barRef}>
          <div className="selection-toolbar-bar" role="group" aria-label="Selected text actions" onMouseDown={(e) => e.preventDefault()}>
            {!inPane && (
              <button
                type="button"
                onClick={() => {
                  window.getSelection()?.removeAllRanges();
                  setAnchor(null);
                  openSideChat(threadId, anchor.text).catch(toastFailure("Couldn't open side chat"));
                }}
              >
                Start a side chat
              </button>
            )}
            <button type="button" onClick={() => add(anchor)}>
              Reply
            </button>
          </div>
        </SelectionPopover>
      )}
      {pending && commentVisible && (
        <SelectionPopover rect={pending.rect} containerRef={containerRef} surfaceRef={commentRef} className="annotation-comment-toolbar">
          <AnnotationComment
            key={pending.attachment.annotationId}
            initial={pending.attachment.annotation}
            onChange={(comment) => editComment(pending, comment)}
            onSave={(comment) => {
              editComment(pending, comment);
              finish();
              // the composer takes the keyboard, so a second Enter sends the message
              dispatchComposerFocus(window, threadId);
            }}
            onCancel={finish}
            onDelete={() => remove(pending)}
          />
        </SelectionPopover>
      )}
    </>,
    document.body,
  );
}
