// Deterministic promise boundaries and queued reads for ownership, ordering and failure unit tests.

export interface Deferred<T> {
  promise: Promise<T>;
  /** The value may be left out when undefined is a valid T (void, any, unknown). */
  resolve: (...value: undefined extends T ? [T?] : [T]) => void;
  reject: (error: unknown) => void;
}

/** Release a real boundary at the exact point the test chooses; rejection is observed by its caller. */
export function deferred<T = any>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as Deferred<T>['resolve'];
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Wait one turn of the event loop: queued microtasks and ready I/O callbacks run first. */
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Mock only the read boundary; every call has its own independently settleable request. */
export function controlledReads<T>() {
  const requests: Deferred<T>[] = [];
  const read = () => {
    const next = deferred<T>();
    requests.push(next);
    return next.promise;
  };
  return { read, requests };
}
