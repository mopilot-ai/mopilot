// A Host chat's desktop in the pane (G8 #3903): the display as the Host paints it, by polled stills main pushes while the pane shows it, and the user's clicks, scrolls and keys sent to that desktop while they have taken over (electron/capabilities/hostDesktopView.cjs).
import { useEffect, useRef, useState } from 'react';
import { useEffectOn } from '../../../lib/effects';
import { native } from '../../../lib/native';
import { noteIgnored } from '../../../lib/ignored';
import { pagePoint } from '../../../lib/remoteView';
import { HostCursor, useHostCursor } from './HostCursor';

type Frame = { src: string; width: number; height: number; pixelsPerPoint: number; display: { x: number; y: number }; version: number };

const note = (machine: string) => ({
  idle: `The agent isn't using ${machine}'s desktop right now.`,
  opening: `Opening ${machine}'s desktop…`,
});

export function HostDesktopSurface({
  paneId,
  chatId,
  hostId,
  machine,
  shown,
  takenOver,
}: {
  paneId: string;
  chatId: string;
  /** the Host this pane is for: a watch is for one machine, so a chat that moves to another is not shown here */
  hostId: string;
  /** the machine whose desktop this is: said at the top, so nobody takes it for their own screen */
  machine: string;
  shown: boolean;
  takenOver: boolean;
}) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [problem, setProblem] = useState('');
  const [idle, setIdle] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const cursor = useHostCursor(root, image, frame);
  const receiveCursor = useRef(cursor.receive);
  receiveCursor.current = cursor.receive;
  // follows the chat's desktop on this machine; a new chat or machine is followed afresh
  useEffectOn([chatId, hostId], () => {
    setFrame(null);
    receiveCursor.current({ kind: 'hide', id: 0 });
    setIdle(false);
    setProblem('');
    const off = native.computer.onDesktopFrame((f) => {
      if (f.paneId !== paneId) return;
      if (f.cursor) return receiveCursor.current(f.cursor);
      if (f.error !== undefined) return setProblem(f.error);
      setProblem('');
      if (f.idle) return setIdle(true);
      if (f.data === undefined) return;
      setIdle(false);
      setFrame({
        src: `data:${f.mime ?? 'image/png'};base64,${f.data}`,
        width: f.width ?? 0,
        height: f.height ?? 0,
        pixelsPerPoint: f.pixelsPerPoint ?? 1,
        display: f.display ?? { x: 0, y: 0 },
        version: f.version ?? 0,
      });
    });
    native.computer.desktopWatch(paneId, chatId, hostId).catch((e) => noteIgnored("follow a Host chat's desktop", e));
    return () => {
      off();
      native.computer.desktopStop(paneId).catch((e) => noteIgnored("stop following a Host chat's desktop", e));
    };
  });
  // how the pane shows it: a hidden pane is not polled, a takeover polls faster
  useEffect(() => {
    native.computer
      .desktopView(paneId, { visible: shown, takeover: takenOver })
      .catch((e) => noteIgnored('tell main how a Host desktop is shown', e));
  }, [paneId, shown, takenOver]);

  const send = (input: Parameters<typeof native.computer.desktopInput>[1] | null) => {
    if (input && takenOver)
      native.computer.desktopInput(paneId, input).catch((e) => noteIgnored("send the user's input to a Host desktop", e));
  };
  const pointAt = (e: { clientX: number; clientY: number }) => {
    const box = image.current?.getBoundingClientRect();
    return box && frame ? pagePoint(box, { x: e.clientX, y: e.clientY }, frame) : null;
  };
  const BUTTON = ['left', 'middle', 'right'] as const;

  return (
    <div
      ref={root}
      className="browser-view remote-view host-desktop"
      data-taken-over={takenOver || undefined}
      tabIndex={takenOver ? 0 : -1}
      onPointerDown={(e) => {
        const p = takenOver ? pointAt(e) : null;
        const button = BUTTON[e.button];
        if (!p || !button) return;
        (e.currentTarget as HTMLElement).focus();
        send({ kind: 'click', x: p.x, y: p.y, button, count: Math.min(3, Math.max(1, e.detail)) });
      }}
      onContextMenu={(e) => takenOver && e.preventDefault()}
      onWheel={(e) => {
        const p = takenOver ? pointAt(e) : null;
        if (p) send({ kind: 'scroll', x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY });
      }}
      onKeyDown={(e) => {
        if (!takenOver) return;
        e.preventDefault();
        // a single printable character types itself unless Control or Meta make it a shortcut
        if ([...e.key].length === 1 && !e.ctrlKey && !e.metaKey) send({ kind: 'text', text: e.key });
        else send({ kind: 'key', key: e.key });
      }}
      onPaste={(e) => {
        const text = e.clipboardData.getData('text');
        if (takenOver && text) {
          e.preventDefault();
          send({ kind: 'text', text });
        }
      }}
    >
      <div className="remote-view-bar" role="note" onPointerDown={(e) => e.stopPropagation()}>
        <span className="remote-view-bar-text">
          {takenOver ? `You are driving ${machine}'s desktop, not this Mac.` : `This is ${machine}'s desktop, not this Mac.`}
        </span>
      </div>
      {frame ? (
        <img ref={image} className="remote-view-frame" src={frame.src} alt="The desktop on the other machine" draggable={false} />
      ) : null}
      <HostCursor node={cursor.node} />
      {problem ? (
        <div className="remote-view-note" role="status">
          {problem}
        </div>
      ) : idle ? (
        <div className="remote-view-note" role="status">
          {note(machine).idle}
        </div>
      ) : frame ? null : (
        <div className="remote-view-note" role="status">
          {note(machine).opening}
        </div>
      )}
    </div>
  );
}
