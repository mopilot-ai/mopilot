// Collects JSON-line records from a test's socket or stream, read as the app reads one (the core frames, JsonReader parses):
// keeps a partial record across data events, and fails a wait on a malformed record or an early end.
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';

const require = createRequire(import.meta.url);
const { JsonReader } = require('../../electron/transport/jsonReader.cjs');

type Source = { on(event: 'data', fn: (chunk: string | Buffer) => void): unknown } & {
  on(event: 'end' | 'close', fn: () => void): unknown;
};

export type JsonLineReader = {
  /** Every complete record so far, in arrival order. */
  records: any[];
  /** Resolves once `count` records have arrived; rejects on a malformed record or when the stream ends first. */
  wait(count: number): Promise<any[]>;
  /** Resolves with the first record `match` accepts, under the same failure rules as `wait`. */
  find(match: (record: any) => boolean): Promise<any>;
  /** Text received after the last newline: a record still in flight. */
  pending(): string;
};

export function readJsonLines(source: Source): JsonLineReader {
  const records: any[] = [];
  let failure: Error | null = null;
  let tail = '';
  const waiters = new Set<() => void>();
  const decoder = new StringDecoder('utf8');
  const settle = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const reader = new JsonReader({
    onValue: (value: unknown) => {
      records.push(value);
      settle();
    },
    onInvalid: (_error: Error, line: string) => {
      failure ??= new Error(`Malformed JSON line: ${line}`);
      settle();
    },
    onError: (error: Error) => {
      failure ??= error;
      settle();
    },
  });
  const take = (bytes: Buffer) => {
    reader.push(bytes);
    // what follows the last newline, for `pending`: a test's records are small
    const text = decoder.write(bytes);
    const at = text.lastIndexOf('\n');
    tail = at < 0 ? tail + text : text.slice(at + 1);
    settle();
  };
  source.on('data', (chunk) => take(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
  // once what came is delivered
  const ended = () =>
    reader.finishInput(() => {
      failure ??= new Error(`Stream ended with ${records.length} record(s)${tail ? ` and a partial one: ${tail}` : ''}`);
      settle();
    });
  source.on('end', ended);
  source.on('close', ended);
  const until = <T>(ready: () => T | undefined) =>
    new Promise<T>((resolve, reject) => {
      const check = () => {
        const value = ready();
        if (value !== undefined) waiters.delete(check), resolve(value);
        else if (failure) waiters.delete(check), reject(failure);
      };
      waiters.add(check);
      check();
    });
  return {
    records,
    wait: (count) => until(() => (records.length >= count ? records.slice(0, count) : undefined)),
    find: (match) => until(() => records.find(match)),
    pending: () => tail,
  };
}
