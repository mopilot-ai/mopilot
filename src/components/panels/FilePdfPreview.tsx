// PDF previews own cancellable document/page tasks and expose page navigation, fit-to-pane zoom and text selection.
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { ignoring } from '../../lib/ignored';
import { PreviewError, PreviewLoading } from './PreviewStatus';
import type { PreviewReady } from './PreviewSwap';
import { useEffectOn } from '../../lib/effects';

export function FilePdfPreview({ data, onRetry, onReady, onFailure }: { data: Uint8Array; onRetry: () => void } & PreviewReady) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  useEffectOn([failed], () => {
    if (failed) onFailure?.();
  });
  const [forData, setForData] = useState(data);
  if (forData !== data) {
    setForData(data);
    setPdf(null);
    setPage(1);
    setZoom(1);
    setFailed(false);
  }
  useEffect(() => {
    const owner = new AbortController();
    let task: PDFDocumentLoadingTask | undefined;
    void (async () => {
      try {
        const { openPreviewPdf } = await import('../../lib/previewPdf');
        owner.signal.throwIfAborted();
        const loading = await openPreviewPdf(data, owner.signal);
        task = loading;
        if (owner.signal.aborted) {
          await loading.destroy();
          return;
        }
        const doc = await loading.promise;
        if (!owner.signal.aborted) setPdf(doc);
      } catch {
        if (!owner.signal.aborted) setFailed(true);
      }
    })();
    return () => {
      owner.abort();
      void task?.destroy().catch(ignoring('close the PDF preview'));
    };
  }, [data]);
  if (failed) return <PreviewError message="Could not read this PDF. It may be damaged or password protected." onRetry={onRetry} />;
  if (!pdf) return <PreviewLoading />;
  return (
    <div className="file-pdf-preview">
      <div className="preview-toolbar">
        <button type="button" className="btn" aria-label="Previous page" disabled={page === 1} onClick={() => setPage((n) => n - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {pdf.numPages}
        </span>
        <button type="button" className="btn" aria-label="Next page" disabled={page === pdf.numPages} onClick={() => setPage((n) => n + 1)}>
          Next
        </button>
        <select aria-label="PDF zoom" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
          <option value={1}>Fit width</option>
          <option value={1.25}>125%</option>
          <option value={1.5}>150%</option>
          <option value={2}>200%</option>
        </select>
      </div>
      <PdfPage key={`${page}:${zoom}`} pdf={pdf} page={page} zoom={zoom} onRetry={onRetry} onReady={onReady} onFailure={onFailure} />
    </div>
  );
}

function PdfPage({
  pdf,
  page,
  zoom,
  onRetry,
  onReady,
  onFailure,
}: { pdf: PDFDocumentProxy; page: number; zoom: number; onRetry: () => void } & PreviewReady) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [text, setText] = useState('');
  useEffectOn([status], () => {
    if (status === 'ready') onReady?.();
    else if (status === 'error') onFailure?.();
  });
  useEffect(() => {
    const target = host.current!;
    const measure = () => {
      if (target.clientWidth > 0) setWidth(target.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let alive = true;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    setStatus('loading');
    void (async () => {
      try {
        const documentPage = await pdf.getPage(page);
        if (!alive) return;
        const base = documentPage.getViewport({ scale: 1 });
        const viewport = documentPage.getViewport({ scale: Math.max(0.1, (width - 24) / base.width) * zoom });
        const target = canvas.current!;
        target.width = Math.ceil(viewport.width);
        target.height = Math.ceil(viewport.height);
        render = documentPage.render({ canvas: target, viewport });
        await render.promise;
        if (!alive) return;
        const content = await documentPage.getTextContent();
        if (!alive) return;
        setText(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
        setStatus('ready');
      } catch {
        if (alive) setStatus('error');
      }
    })();
    return () => {
      alive = false;
      render?.cancel();
    };
  }, [pdf, page, zoom, width]);
  return (
    <div ref={host} className="pdf-page-scroll">
      {status === 'loading' && <PreviewLoading />}
      {status === 'error' && <PreviewError onRetry={onRetry} />}
      <canvas ref={canvas} aria-label={`PDF page ${page}`} hidden={status !== 'ready'} />
      {status === 'ready' && (
        <details className="pdf-page-text">
          <summary>Page text</summary>
          <p>{text}</p>
        </details>
      )}
    </div>
  );
}
