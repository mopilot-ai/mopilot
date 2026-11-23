// Request builders for the MoPilot 12-Grid Bench fixture-app unit tests (#1381): GET, urlencoded and multipart POSTs
// in the latin1 body form bench/mgb-serve.mjs hands the apps, and the visible text of a page.

export type Req = { method: string; url: URL; headers: Record<string, string>; body: string };
export type Res = { status: number; headers: Record<string, string>; body: string };

/** A request to an app on `<app>.localhost:8820`. */
export function req(
  method: string,
  path: string,
  o: { app?: string; body?: string; type?: string; headers?: Record<string, string> } = {},
): Req {
  const host = `${o.app ?? 'mail'}.localhost:8820`;
  return {
    method,
    url: new URL(path, `http://${host}`),
    headers: { host, ...(o.type ? { 'content-type': o.type } : {}), ...(o.headers ?? {}) },
    body: o.body ?? '',
  };
}

/** A urlencoded form body (UTF-8 bytes as latin1 text, as the server reads it). */
export function form(fields: Record<string, string | string[]>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) q.append(k, x);
  return { body: Buffer.from(q.toString(), 'utf8').toString('latin1'), type: 'application/x-www-form-urlencoded' };
}

/** A multipart/form-data body with fields and files (file content as UTF-8 text or raw bytes). */
export function multipart(
  fields: Record<string, string>,
  files: { field: string; name: string; type?: string; content: string | Buffer }[] = [],
) {
  const b = 'mgbBoundary7MA4YWxk';
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields))
    chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${b}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'text/plain'}\r\n\r\n`,
        'utf8',
      ),
    );
    chunks.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8'));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(chunks).toString('latin1'), type: `multipart/form-data; boundary=${b}` };
}

/** Text of a page with tags stripped and whitespace collapsed, for assertions on what a person sees. */
export const text = (res: Res) =>
  res.body
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
