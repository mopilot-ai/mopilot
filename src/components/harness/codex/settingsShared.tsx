// Retry presentation shared by Codex settings sections after a failed read.

/** A read that failed, said with Retry where its list would be, instead of an empty list or "off". */
export function LoadFailed({ what, error, retry }: { what: string; error: string; retry: () => void }) {
  return (
    <div className="config-warning" role="alert">
      Couldn't {what}: {error}{' '}
      <button className="btn-pill soft" onClick={retry}>
        Retry
      </button>
    </div>
  );
}
