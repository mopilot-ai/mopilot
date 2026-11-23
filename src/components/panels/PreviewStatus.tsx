// File previews share visible loading and retry states without exposing decoder internals.
import { Spinner } from '../ui/icons';

export function PreviewLoading() {
  return (
    <div className="center-pad" role="status" aria-label="Loading preview">
      <Spinner size={16} />
    </div>
  );
}

export function PreviewError({
  message = 'Could not preview this file. It may be missing, damaged or encrypted.',
  onRetry,
}: {
  message?: string;
  onRetry: () => void;
}) {
  return (
    <div className="empty-state preview-error">
      <div role="alert">{message}</div>
      <button className="btn" type="button" onClick={onRetry} aria-label="Retry file preview">
        Retry
      </button>
    </div>
  );
}
