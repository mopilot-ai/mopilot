// A tab on a Host in the browser pane (package 2.6): the page as the Host paints it, by frames main pushes while the pane shows it, and the user's pointer and keys sent to the page while they have taken the tab over.
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { useEffectOn } from '../../../lib/effects';
import { native } from '../../../lib/native';
import { noteIgnored } from '../../../lib/ignored';
import {
  RemoteViewHandle,
  forwardedUrl,
  keyInput,
  loopbackTarget,
  mouseInput,
  pagePoint,
  type LoopbackTarget,
  type RemoteFrameState,
} from '../../../lib/remoteView';
import { hostOfTabKey } from '../../../lib/hostTabKey';
import { openPaneTab } from '../../../store/panes';
import { userError } from '../../../../shared/userError.mjs';
import type { WebviewElement } from './ViewSurface';

export function RemoteViewSurface({
  handleRef,
  paneId,
  chatId,
  tabKey,
  shown,
  takenOver,
}: {
  handleRef: MutableRefObject<WebviewElement | null>;
  paneId: string;
  /** the agent's chat whose tab on the Host this is */
  chatId: string;
  /** the pane key, which names the Host */
  tabKey: string;
  shown: boolean;
  /** the user took the tab over: their input reaches the page */
  takenOver: boolean;
}) {
  const [handle] = useState(() => new RemoteViewHandle());
  const [frame, setFrame] = useState<RemoteFrameState | null>(null);
  const [problem, setProblem] = useState('');
  const image = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    handleRef.current = handle as unknown as WebviewElement;
    return () => {
      if (handleRef.current === (handle as unknown as WebviewElement)) handleRef.current = null;
    };
  }, [handle, handleRef]);
  // follows the tab for the life of this pane tab
  useEffectOn([], () => {
    const off = native.browser.remote.onFrame((f) => {
      if (f.paneId !== paneId) return;
      if (f.error !== undefined) return setProblem(f.error);
      setProblem('');
      handle.receive(f);
      setFrame(handle.state);
    });
    native.browser.remote.watch(paneId, chatId, tabKey).catch((e) => noteIgnored('follow a tab on a Host', e));
    return () => {
      off();
      native.browser.remote.stop(paneId).catch((e) => noteIgnored('stop following a tab on a Host', e));
    };
  });
  // how the pane shows it: hidden panes are not polled, a takeover polls faster
  useEffect(() => {
    native.browser.remote
      .view(paneId, { visible: shown, takeover: takenOver })
      .catch((e) => noteIgnored('tell main how a tab on a Host is shown', e));
  }, [paneId, shown, takenOver]);

  // a dev server on the machine's own loopback can open in this Mac's browser through an ssh port forward
  const local = frame ? loopbackTarget(frame.url) : null;
  const hostId = hostOfTabKey(tabKey);

  const send = (input: Parameters<typeof native.browser.remote.input>[1] | null) => {
    if (input && takenOver)
      native.browser.remote.input(paneId, input).catch((e) => noteIgnored("send the user's input to a tab on a Host", e));
  };
  const pointAt = (e: { clientX: number; clientY: number }) => {
    const box = image.current?.getBoundingClientRect();
    return box && frame ? pagePoint(box, { x: e.clientX, y: e.clientY }, frame) : null;
  };
  /** A pointer event on the frame: down and up always, moves only with a button held (a drag). */
  const pointer = (type: 'down' | 'up' | 'move') => (e: React.PointerEvent) => {
    const point = takenOver ? pointAt(e) : null;
    if (!point || (type === 'move' && e.buttons === 0)) return;
    if (type === 'down') (e.currentTarget as HTMLElement).focus();
    send(mouseInput(type, point, e));
  };

  return (
    <div
      className="browser-view remote-view"
      data-taken-over={takenOver || undefined}
      tabIndex={takenOver ? 0 : -1}
      onPointerDown={pointer('down')}
      onPointerUp={pointer('up')}
      onPointerMove={pointer('move')}
      onContextMenu={(e) => takenOver && e.preventDefault()}
      onWheel={(e) => {
        const point = pointAt(e);
        if (point) send({ kind: 'mouse', type: 'wheel', x: point.x, y: point.y, deltaX: e.deltaX, deltaY: e.deltaY });
      }}
      onKeyDown={(e) => {
        if (!takenOver) return;
        e.preventDefault();
        send(keyInput('down', e));
      }}
      onKeyUp={(e) => {
        if (!takenOver) return;
        e.preventDefault();
        send(keyInput('up', e));
      }}
      onPaste={(e) => {
        const text = e.clipboardData.getData('text');
        if (takenOver && text) {
          e.preventDefault();
          send({ kind: 'text', text });
        }
      }}
    >
      {local && hostId ? <OpenHereBar hostId={hostId} target={local} /> : null}
      {frame ? (
        <img
          ref={image}
          className="remote-view-frame"
          src={frame.src}
          alt={frame.title || 'The page on the other machine'}
          draggable={false}
        />
      ) : null}
      {problem ? (
        <div className="remote-view-note" role="status">
          {problem}
        </div>
      ) : frame ? null : (
        <div className="remote-view-note" role="status">
          Opening the page on the other machine…
        </div>
      )}
    </div>
  );
}

/** Offers a dev server on the machine's loopback to this Mac's own browser: its port is forwarded over ssh and the pane opens the forwarded address. */
function OpenHereBar({ hostId, target }: { hostId: string; target: LoopbackTarget }) {
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState('');
  const open = () => {
    setOpening(true);
    setFailure('');
    native.host
      .forwardPort(hostId, target.port)
      .then(({ localPort }) => openPaneTab('browser', { url: forwardedUrl(target, localPort) }))
      .catch((e) => setFailure(userError(e)))
      .finally(() => setOpening(false));
  };
  // the bar is the pane's own: its clicks and keys never reach the page during a takeover
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div
      className="remote-view-bar"
      role="status"
      onPointerDown={stop}
      onPointerUp={stop}
      onPointerMove={stop}
      onKeyDown={stop}
      onKeyUp={stop}
      onWheel={stop}
    >
      <span className="remote-view-bar-text">{failure || `This page runs on the other machine (port ${target.port}).`}</span>
      <button type="button" className="remote-view-bar-action" disabled={opening} onClick={open}>
        {opening ? 'Opening…' : 'Open on this Mac'}
      </button>
    </div>
  );
}
