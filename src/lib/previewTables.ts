// Delimited text and workbook previews share bounded, plain-text sheets and never inject cell HTML.
export type PreviewSheet = { name: string; rows: string[][]; truncated: boolean };
export const PREVIEW_ROWS = 1000;
export const PREVIEW_COLUMNS = 100;

export function boundedSheet(name: string, rows: unknown[][]): PreviewSheet {
  return {
    name,
    rows: rows.slice(0, PREVIEW_ROWS).map((row) => row.slice(0, PREVIEW_COLUMNS).map((cell) => String(cell ?? ''))),
    truncated: rows.length > PREVIEW_ROWS || rows.some((row) => row.length > PREVIEW_COLUMNS),
  };
}

/** Quoted separators, escaped quotes, CRLF and multiline fields follow CSV quoting rules. */
export function delimitedSheet(source: string, delimiter: string): PreviewSheet {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  const text = source.replace(/^\uFEFF/, '');
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '"') {
      if (quoted && text[at + 1] === '"') {
        field += '"';
        at++;
      } else if (quoted || field === '') quoted = !quoted;
      else field += char;
    } else if (!quoted && char === delimiter) {
      row.push(field);
      field = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[at + 1] === '\n') at++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length > PREVIEW_ROWS) break;
    } else field += char;
  }
  if (quoted) throw new Error('A quoted field is incomplete.');
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return boundedSheet('Table', rows);
}
