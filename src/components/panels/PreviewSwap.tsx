// A replacement preview stages beside the last valid generation and becomes visible only after decoding succeeds.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PreviewError } from './PreviewStatus';

export type PreviewReady = { onReady?: () => void; onFailure?: () => void; onRetry?: () => void };
export type PreviewLifecycle = Required<PreviewReady>;
type Generation = { id: number; revision?: string; value?: string };
export function PreviewSwap({
  revision,
  value,
  children,
}: {
  revision?: string;
  value?: string;
  children: (generation: Generation & PreviewLifecycle) => ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const [request, setRequest] = useState({ revision, value, attempt, id: 0 });
  const [shown, setShown] = useState<Generation | null>(null);
  const [failed, setFailed] = useState(false);
  if (request.revision !== revision || request.value !== value || request.attempt !== attempt) {
    setRequest({ revision, value, attempt, id: request.id + 1 });
    setFailed(false);
  }
  const latest = useRef({ id: request.id, failed });
  latest.current = { id: request.id, failed };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const candidate: Generation = {
    id: request.id,
    value: request.value,
    revision: request.id === 0 ? revision : `${revision ?? ''}:${request.id}`,
  };
  const generations = shown && shown.id !== candidate.id ? [shown, candidate] : [candidate];
  return (
    <div className="preview-swap">
      {shown && shown.id !== candidate.id && failed && (
        <PreviewError
          message="Could not refresh this preview. Showing its last readable version."
          onRetry={() => setAttempt((n) => n + 1)}
        />
      )}
      {shown && shown.id !== candidate.id && !failed && (
        <div className="preview-refresh-status" role="status">
          Refreshing preview…
        </div>
      )}
      {generations.map((g) => (
        <div key={g.id} className="preview-generation" hidden={!!shown && shown.id !== g.id}>
          {children({
            ...g,
            onRetry: () => setAttempt((n) => n + 1),
            onReady: () => {
              if (alive.current && latest.current.id === g.id && !latest.current.failed) setShown(g);
            },
            onFailure: () => {
              if (alive.current && latest.current.id === g.id) setFailed(true);
            },
          })}
        </div>
      ))}
    </div>
  );
}
