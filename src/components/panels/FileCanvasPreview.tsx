// One source revision owns its sandbox, bootstrap result and messages; controls persist without exposing filesystem IPC.
import { useEffect, useId, useRef, useState } from 'react';
import { canvasDocument } from '../../lib/visualization';
import { loadCanvasPreview } from '../../lib/canvas/loader';
import { retainCanvasState } from '../../lib/canvas/stateOwner';
import { isAbsolutePath } from '../../lib/paths';
import * as sessionOpen from '../../session/open';
import { PreviewError, PreviewLoading } from './PreviewStatus';
import type { PreviewReady } from './PreviewSwap';

export function FileCanvasPreview({
  source,
  path,
  cwd,
  dark,
  onReady,
  onFailure,
}: { source: string; path: string; cwd: string; dark: boolean } & PreviewReady) {
  const id = useId();
  const generation = useRef(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const callbacks = useRef({ onReady, onFailure });
  callbacks.current = { onReady, onFailure };
  const [attempt, setAttempt] = useState(0);
  const [document, setDocument] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState('');
  const stateOwner = useRef<ReturnType<typeof retainCanvasState>>(null);
  useEffect(() => {
    const owner = retainCanvasState(path, localStorage);
    stateOwner.current = owner;
    return () => owner.release();
  }, [path]);
  useEffect(() => {
    let current = true;
    let failed = false;
    let acknowledged = 0;
    const token = JSON.stringify([id, path, ++generation.current, attempt]);
    const owner = stateOwner.current!;
    setError(false);
    setDocument(null);
    const fail = () => {
      if (current) {
        failed = true;
        setError(true);
        callbacks.current.onFailure?.();
      }
    };
    const timeout = setTimeout(fail, 15_000);
    const restore = (snapshot: ReturnType<typeof owner.read>) => {
      setNotice(snapshot.notice);
      frame.current?.contentWindow?.postMessage(
        { channel: 'mopilot-canvas', id: token, type: 'restore', state: snapshot.state, revision: snapshot.revision, acknowledged },
        '*',
      );
    };
    const unsubscribe = owner.subscribe(restore);
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (
        !current ||
        !frame.current ||
        event.source !== frame.current.contentWindow ||
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        data.channel !== 'mopilot-canvas' ||
        data.id !== token
      )
        return;
      if (data.type === 'booted' || data.type === 'ready') {
        const latest = owner.read();
        if (data.type === 'ready' && data.revision === latest.revision) {
          clearTimeout(timeout);
          if (!failed) callbacks.current.onReady?.();
        } else restore(latest);
      } else if (data.type === 'error') {
        clearTimeout(timeout);
        fail();
      } else if (
        data.type === 'state' &&
        typeof data.key === 'string' &&
        Number.isSafeInteger(data.sequence) &&
        data.sequence > acknowledged
      ) {
        const previous = acknowledged;
        try {
          acknowledged = data.sequence;
          owner.set(data.key, data.value);
        } catch {
          acknowledged = previous;
          setNotice('This control could not be saved. Canvas controls must contain bounded JSON data.');
        }
      } else if (data.type === 'link' || data.type === 'action') {
        if (!navigator.userActivation?.isActive) return;
        let href = data.type === 'link' ? data.href : data.action?.type === 'openFile' ? data.action.path : null;
        if (
          typeof href === 'string' &&
          href.trim() &&
          !href.includes('\0') &&
          (isAbsolutePath(href) || /^(https?:|file:)/i.test(href) || !/^[a-z][a-z\d+.-]*:/i.test(href))
        ) {
          const line = data.type === 'action' ? data.action.selection?.startLineNumber : null;
          if (Number.isSafeInteger(line) && line > 0) href += `#L${line}`;
          sessionOpen.openMessageLink(href, cwd);
        } else setNotice('This action is unavailable in MoPilot. Ask the agent to open the destination.');
      }
    };
    window.addEventListener('message', receive);
    void loadCanvasPreview()
      .then(({ runtime, compile }) => {
        if (!current || failed) return;
        const latest = owner.read();
        setNotice(latest.notice);
        setDocument(canvasDocument(compile(source), runtime, { id: token, dark, state: latest.state }));
      })
      .catch(fail);
    return () => {
      current = false;
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
      unsubscribe();
    };
  }, [source, path, cwd, dark, attempt, id]);
  return (
    <>
      {notice && <div role="status">{notice}</div>}
      {error ? (
        <PreviewError
          message="Could not render this canvas. View its source to inspect it, or ask the agent to repair it."
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : document === null ? (
        <PreviewLoading />
      ) : (
        <iframe
          ref={frame}
          className="file-document-frame"
          title="Canvas preview"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={document}
        />
      )}
    </>
  );
}
