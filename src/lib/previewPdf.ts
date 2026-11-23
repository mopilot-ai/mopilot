// PDF.js is loaded only for a PDF preview and uses a bundled worker rather than a network dependency.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export async function openPreviewPdf(data: Uint8Array, signal: AbortSignal) {
  const pdfjs = await import('pdfjs-dist');
  signal.throwIfAborted();
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const resources = new URL('preview/pdf/', document.baseURI).href;
  return pdfjs.getDocument({
    data: data.slice(),
    useSystemFonts: true,
    cMapUrl: `${resources}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${resources}standard_fonts/`,
    wasmUrl: `${resources}wasm/`,
    iccUrl: `${resources}iccs/`,
  });
}
