// The macOS update download: MoPilot fetches the update zip itself, with progress, a stall timeout instead of a
// total one, and resume with Range, then serves the finished file to Squirrel.Mac on loopback (Squirrel reports no
// progress, and a fixed limit failed slow downloads that were still moving).
const crypto = require('node:crypto');
const { fs } = require('../platform/ports/fs.cjs');
const http = require('node:http');
const path = require('node:path');
const { pipeline } = require('node:stream');
const { readJsonAsync, writeAtomic } = require('../platform/fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { CHECK_FOR_UPDATES } = require('../../shared/uiLabels.mjs');
const { userError } = require('../../shared/userError.mjs');

/** No bytes for this long ends an attempt; the next one resumes where it stopped. */
const STALL_MS = 60_000;
/** Attempts in a row that received nothing before the download fails. */
const MAX_FAILURES = 5;

/** What the user reads when `url` answered `status`: the server and the status, and what it usually means. */
function statusFailure(what, url, status) {
  const hint =
    status === 403 || status === 407
      ? ' A proxy or firewall on this network may be blocking it.'
      : status >= 500
        ? ' Try again later.'
        : '';
  return `${what} failed: ${new URL(url).host} answered HTTP ${status}.${hint}`;
}

/** What the user reads when `url` could not be reached at all. */
function unreachableFailure(what, url, error) {
  return `${what} failed: could not reach ${new URL(url).host}. ${userError(error)}`;
}

/** A failure that another attempt will not fix (an HTTP error status, a file that can't be written). */
class FatalDownloadError extends Error {}

/** A download that arrived but is not the file the server announced; another attempt may fix it. */
class BadDownloadError extends Error {}

/** Wait `ms` between attempts; an abort ends the wait at once. */
function backOff(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve(undefined);
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Wait for backpressure or file closure, then release both competing event subscriptions. */
function waitForDrain(out) {
  return new Promise((resolve) => {
    const done = () => {
      out.off('drain', done);
      out.off('close', done);
      resolve(undefined);
    };
    out.once('drain', done);
    out.once('close', done);
  });
}

/** @param {string} file */
async function sizeOf(file) {
  return fs.promises.stat(file).then(
    (s) => s.size,
    () => 0,
  );
}

/**
 * Download `url` into `dir`, resuming a partial file left by an earlier attempt or run. One update is kept: other
 * files in `dir` are removed. Resolves the finished file's path.
 * @param {{ url: string, dir: string, fetch: (url: string, init: object) => Promise<any>, signal: AbortSignal,
 *   headers?: Record<string, string>, onProgress: (received: number, total: number | null) => void,
 *   stallMs?: number, maxFailures?: number, wait?: (ms: number, signal: AbortSignal) => Promise<unknown> }} o
 */
async function downloadUpdate(o) {
  o.signal.throwIfAborted();
  const stallMs = o.stallMs ?? STALL_MS;
  const maxFailures = o.maxFailures ?? MAX_FAILURES;
  const name = crypto.createHash('sha256').update(o.url).digest('hex').slice(0, 16);
  const file = path.join(o.dir, `${name}.zip`);
  const part = `${file}.part`;
  const meta = `${file}.json`;
  await fs.promises.mkdir(o.dir, { recursive: true });
  for (const f of await fs.promises.readdir(o.dir))
    if (!f.startsWith(name)) await fs.promises.rm(path.join(o.dir, f), { recursive: true, force: true });
  /** @type {{ validator: string | null, total: number | null, complete?: boolean } | null} */
  let info = await readJsonAsync(meta);
  o.signal.throwIfAborted();
  if (info?.complete && (await sizeOf(file)) === info.total) {
    o.signal.throwIfAborted();
    o.onProgress(info.total, info.total);
    return file;
  }
  let failures = 0;
  // the most of the file ever on disk: only an attempt that gets further counts as progress
  let best = 0;
  for (;;) {
    o.signal.throwIfAborted();
    // resume only what a validator ties to the same file on the server
    const have = info?.validator ? await sizeOf(part) : 0;
    // Cancellation may have happened while stat was pending, before the abort listener existed.
    o.signal.throwIfAborted();
    let received = 0;
    let reached = 0;
    /** @type {Error | null} */
    let writeError = null;
    const attempt = new AbortController();
    const onAbort = () => attempt.abort(o.signal.reason);
    o.signal.addEventListener('abort', onAbort, { once: true });
    let stalled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        attempt.abort(new Error('stalled'));
      }, stallMs);
    };
    try {
      arm();
      const headers = { ...o.headers };
      if (have > 0 && info?.validator) Object.assign(headers, { range: `bytes=${have}-`, 'if-range': info.validator });
      const res = await o.fetch(o.url, { headers, signal: attempt.signal });
      o.signal.throwIfAborted();
      const resumed = res.status === 206 && have > 0 && new RegExp(`^bytes ${have}-`).test(res.headers.get('content-range') ?? '');
      if (res.status === 416 && have > 0) {
        // the partial file no longer matches: start over
        info = null;
        throw new Error('the partial download no longer matches the server');
      }
      if (!resumed && res.status !== 200) throw new FatalDownloadError(statusFailure('Update download', o.url, res.status));
      let total;
      if (resumed) total = info?.total ?? null;
      else {
        const length = Number(res.headers.get('content-length'));
        total = Number.isFinite(length) && length > 0 ? length : null;
        const etag = res.headers.get('etag');
        info = { validator: (etag && !etag.startsWith('W/') ? etag : res.headers.get('last-modified')) || null, total };
        writeAtomic(meta, JSON.stringify(info));
      }
      const start = resumed ? have : 0;
      reached = start;
      o.onProgress(start, total);
      const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
      // a write that fails (a full disk) ends the attempt; the stream closes after its error
      const closed = new Promise((resolve) => out.on('close', resolve));
      out.on('error', (error) => {
        writeError = error;
        attempt.abort(error);
      });
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          o.signal.throwIfAborted();
          if (end) break;
          arm();
          received += value.byteLength;
          reached = start + received;
          if (!out.write(value)) await waitForDrain(out);
          o.signal.throwIfAborted();
          if (writeError) throw writeError;
          o.onProgress(reached, total);
        }
      } finally {
        out.end();
        await closed;
      }
      if (writeError) throw writeError;
      const size = await sizeOf(part);
      o.signal.throwIfAborted();
      if (total !== null && size > total) {
        // more than the server announced: the partial file can't be trusted, start over
        info = null;
        throw new BadDownloadError(`the download is larger than the server said (${size} of ${total} bytes)`);
      }
      if (total !== null && size < total) throw new BadDownloadError(`the download ended early (${size} of ${total} bytes)`);
      await fs.promises.rename(part, file);
      o.signal.throwIfAborted();
      writeAtomic(meta, JSON.stringify({ ...info, total: size, complete: true }));
      return file;
    } catch (error) {
      if (o.signal.aborted) throw o.signal.reason;
      if (writeError) throw new FatalDownloadError(`Could not save the update. ${userError(writeError)}`);
      if (error instanceof FatalDownloadError) throw error;
      if (reached > best) {
        best = reached;
        failures = 1;
      } else failures++;
      if (failures >= maxFailures)
        throw new Error(
          stalled
            ? `Update download stalled: ${new URL(o.url).host} sent no data for ${Math.round(stallMs / 1000)} seconds. ${CHECK_FOR_UPDATES} resumes it.`
            : error instanceof BadDownloadError
              ? `Update download failed: ${error.message}. ${CHECK_FOR_UPDATES} tries again.`
              : unreachableFailure('Update download', o.url, error),
        );
      await (o.wait ?? backOff)(Math.min(30_000, 1000 * 2 ** failures), o.signal);
    } finally {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Serve a downloaded update to Squirrel.Mac on loopback: a JSON feed at `feedUrl` whose url is the file. Squirrel
 * then installs it exactly as it would from the server (it still checks the code signature).
 * @param {{ file: string, update: { name: string, notes: string, pub_date?: string } }} o
 * @returns {Promise<{ feedUrl: string, close: () => void }>}
 */
function serveUpdate({ file, update }) {
  const token = crypto.randomBytes(16).toString('hex');
  const server = http.createServer((req, res) => {
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    if (req.url === `/${token}/feed.json`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...update, url: `http://127.0.0.1:${port}/${token}/update.zip` }));
      return;
    }
    if (req.url === `/${token}/update.zip`) {
      fs.promises.stat(file).then(
        (s) => {
          res.writeHead(200, { 'content-type': 'application/zip', 'content-length': s.size });
          pipeline(fs.createReadStream(file), res, (error) => {
            if (error) noteIgnored('serve a downloaded update', error);
          });
        },
        () => (res.writeHead(404), res.end()),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ feedUrl: `http://127.0.0.1:${port}/${token}/feed.json`, close: () => server.close() });
    });
  });
}

module.exports = { downloadUpdate, serveUpdate, statusFailure, unreachableFailure, STALL_MS };
