// Local Office decoders build inert document markup or bounded worksheets; only the sandbox displays their output.
import { filePreviewKind } from '../../shared/filePreview.mjs';
import { boundedSheet, PREVIEW_ROWS, PREVIEW_COLUMNS, type PreviewSheet } from './previewTables';

export type DocumentRead = { kind: 'binary'; data: Uint8Array } | { kind: 'text'; text: string };
export type OfficePreview = { kind: 'html'; html: string } | { kind: 'sheets'; sheets: PreviewSheet[] } | { kind: 'text'; text: string };

export function checkPreviewActive(signal: AbortSignal) {
  signal.throwIfAborted();
}

export async function decodeOffice(path: string, input: DocumentRead, signal: AbortSignal): Promise<OfficePreview> {
  checkPreviewActive(signal);
  if (input.kind === 'text') return { kind: 'text', text: input.text };
  const kind = filePreviewKind(path);
  if (kind === 'workbook') {
    const xlsx = await import('xlsx');
    checkPreviewActive(signal);
    const options = { type: 'array' as const, sheetRows: PREVIEW_ROWS + 1, cellHTML: false, cellFormula: false, bookVBA: false };
    const book = xlsx.read(input.data, options);
    const sheets = book.SheetNames.map((name) => {
      let sheet = book.Sheets[name];
      const original = xlsx.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
      const range = {
        s: original.s,
        e: { r: Math.min(original.e.r, original.s.r + PREVIEW_ROWS - 1), c: Math.min(original.e.c, original.s.c + PREVIEW_COLUMNS - 1) },
      };
      // SheetJS's parse ceiling is absolute; reopen only this sheet when its admitted used rows start later.
      if (range.e.r >= options.sheetRows)
        sheet = xlsx.read(input.data, { ...options, sheets: [name], sheetRows: range.e.r + 1 }).Sheets[name];
      const bounded = boundedSheet(name, xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', range }));
      bounded.truncated = original.e.r > range.e.r || original.e.c > range.e.c;
      return bounded;
    });
    return { kind: 'sheets', sheets };
  }
  if (kind === 'word') {
    const { renderAsync } = await import('docx-preview');
    checkPreviewActive(signal);
    const page = document.implementation.createHTMLDocument('Document');
    const body = page.createElement('div'),
      styles = page.createElement('div');
    await renderAsync(input.data, body, styles, { useBase64URL: true, ignoreFonts: true, renderAltChunks: false });
    checkPreviewActive(signal);
    return { kind: 'html', html: styles.innerHTML + body.innerHTML };
  }
  const [pptx, renderer] = await Promise.all([import('@office-kit/pptx'), import('@office-kit/pptx-preview')]);
  checkPreviewActive(signal);
  const presentation = await pptx.loadPresentation(input.data);
  checkPreviewActive(signal);
  const slides = pptx.getSlides(presentation);
  if (!slides.length) throw new Error('This presentation has no slides.');
  if (slides.length > 200) throw new Error('Presentation is too large to preview (200 slides maximum).');
  return {
    kind: 'html',
    html: slides
      .map((slide, index) => `<section aria-label="Slide ${index + 1}">${renderer.renderSlideToSvg(presentation, slide)}</section>`)
      .join('\n'),
  };
}

/** No document scripts, forms, remote assets or parent access, including output emitted by Office libraries. */
export function officePreviewDocument(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><style>body{margin:0;background:#eee;color:#222;font:14px system-ui}section{margin:12px auto;max-width:100%;background:white}section>svg{display:block;width:100%;height:auto}.docx-wrapper{padding:12px!important}.docx-wrapper>section{max-width:100%;box-sizing:border-box}img{max-width:100%}</style></head><body>${html}</body></html>`;
}
