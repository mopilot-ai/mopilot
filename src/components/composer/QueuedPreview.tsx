// Read a queued prompt in full without changing its place in the queue or the composer's draft.
import { useCallback, useEffect, type ReactNode } from 'react';
import { focusAfterPlacement } from '../../lib/placedFocus';
import { Popover, useAnchor } from '../ui/Popover';
import { X } from '../ui/icons';

/** The detach callback still sees the focused panel; after the commit only live controls of its chat may take focus. */
function retireFocus(panel: HTMLElement, trigger: HTMLElement, threadId: string) {
  if (!panel.contains(document.activeElement)) return;
  const tray = trigger.closest<HTMLElement>('.queue-tray')!;
  const composer = trigger.closest<HTMLElement>('[data-composer-chat]');
  queueMicrotask(() => {
    if (document.activeElement !== document.body) return;
    const next =
      tray.isConnected && tray.dataset.queueChat === threadId
        ? [...tray.querySelectorAll<HTMLButtonElement>('.queue-row:not([inert]) .queue-text')].find((button) => button !== trigger)
        : undefined;
    if (next) next.focus();
    else if (composer?.isConnected && composer.dataset.composerChat === threadId)
      composer.querySelector<HTMLElement>('.composer-input, .quick-chat-input')?.focus();
  });
}

export function QueuedPreview({
  threadId,
  label,
  body = label,
  leaving,
  children,
}: {
  threadId: string;
  label: string;
  /** what the preview reads when it is not the label (a message another session sent: its body, not who sent it) */
  body?: string;
  leaving: boolean;
  children: ReactNode;
}) {
  const preview = useAnchor<HTMLButtonElement>();
  // React 19 calls the returned detach cleanup, rather than calling this ref again with null.
  const focusBody = useCallback(
    (panel: HTMLDivElement) => {
      const trigger = preview.anchor!;
      const cancelFocus = focusAfterPlacement(panel.querySelector<HTMLElement>('.queue-preview-body')!);
      return () => {
        cancelFocus();
        retireFocus(panel, trigger, threadId);
      };
    },
    [preview.anchor, threadId],
  );
  useEffect(() => {
    if (leaving) preview.close();
  }, [leaving, preview.close]);
  const close = () => {
    preview.close();
    preview.anchor!.focus();
  };
  return (
    <>
      <button
        ref={preview.ref}
        type="button"
        className="queue-text"
        title={label}
        aria-label={`Preview queued message: ${label.replace(/\s+/g, ' ').trim().slice(0, 80)}`}
        aria-haspopup="dialog"
        aria-expanded={preview.open && !leaving}
        onClick={preview.toggle}
      >
        {children}
      </button>
      <Popover anchor={preview.anchor} open={preview.open && !leaving} onClose={close} placement="top-start">
        <div ref={focusBody} className="queue-preview" role="dialog" aria-label="Queued message preview">
          <div className="queue-preview-header">
            <span>Queued message</span>
            <button type="button" className="icon-btn sm" aria-label="Close preview" onClick={close}>
              <X size={16} aria-hidden />
            </button>
          </div>
          <div className="queue-preview-body" tabIndex={0}>
            {body}
          </div>
        </div>
      </Popover>
    </>
  );
}
