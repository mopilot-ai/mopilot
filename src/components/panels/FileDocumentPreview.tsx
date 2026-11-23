// Every binary file preview owns one read/decoder attempt, retiring stale success and failure on replacement.
import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import { decodeOffice, officePreviewDocument, type OfficePreview } from '../../lib/previewOffice';
import { filePreviewKind } from '../../../shared/filePreview.mjs';
import { PreviewError, PreviewLoading } from './PreviewStatus';
import { PreviewTable } from './PreviewTable';
import { FilePdfPreview } from './FilePdfPreview';
import type { PreviewLifecycle } from './PreviewSwap';
import { useEffectOn } from '../../lib/effects';

export function FileDocumentPreview({ path, onRetry, onReady, onFailure }: { path: string; onRetry: () => void } & PreviewLifecycle) {
  const [result, setResult] = useState<OfficePreview | { kind: 'pdf'; data: Uint8Array } | null>(null);
  const [error, setError] = useState(false);
  useEffectOn([result, error], () => {
    if (error) onFailure();
    else if (result && (result.kind === 'sheets' || result.kind === 'text')) onReady();
  });
  useEffect(() => {
    const owner = new AbortController();
    void (async () => {
      try {
        const input = await native.fs.readPreview(path);
        owner.signal.throwIfAborted();
        const preview =
          filePreviewKind(path) === 'pdf' && input.kind === 'binary'
            ? { kind: 'pdf' as const, data: input.data }
            : await decodeOffice(path, input, owner.signal);
        if (!owner.signal.aborted) setResult(preview);
      } catch {
        if (!owner.signal.aborted) setError(true);
      }
    })();
    return () => owner.abort();
  }, [path]);
  if (error) return <PreviewError onRetry={onRetry} />;
  if (!result) return <PreviewLoading />;
  if (result.kind === 'pdf') return <FilePdfPreview data={result.data} onRetry={onRetry} onReady={onReady} onFailure={onFailure} />;
  if (result.kind === 'sheets') return <PreviewTable sheets={result.sheets} />;
  if (result.kind === 'text')
    return (
      <div className="file-legacy-preview">
        <p className="preview-notice">Text preview. Original formatting is not available for this older document format.</p>
        <pre>{result.text}</pre>
      </div>
    );
  return (
    <iframe
      className="file-document-frame"
      title="Document preview"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={officePreviewDocument(result.html)}
      onLoad={onReady}
      onError={onFailure}
    />
  );
}
