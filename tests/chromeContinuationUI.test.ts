// Deferred continuation reads belong to their notice across replacement, dismissal and Strict Mode cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act, StrictMode } from 'react';
import { mount } from './support/harness-ui-kit.ts';
import { controlledReads, deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';
let read: () => Promise<any>;
let remove: (...args: any[]) => Promise<boolean> = async () => true;
installNativeStub({ browser: { handoffContinuation: () => read() }, session: { removeQueued: (...args: any[]) => remove(...args) } });
const { useChromeContinuation } = await import('../src/lib/useChromeContinuation.ts');
let api: ReturnType<typeof useChromeContinuation>;
function Notice({ owner }: { owner: string | null }) {
  api = useChromeContinuation(owner);
  return null;
}
const request = { chatId: 'chat', url: 'https://site.test/' };
const result = { message: 'current tools', precondition: { url: request.url, token: 'current' } };

test('only a live notice sends; replacement reads, disposal and repeated clicks retain ownership', async () => {
  const reads = controlledReads<any>();
  read = reads.read;
  const sent: unknown[] = [],
    settled: unknown[] = [];
  const send = async (...args: unknown[]) => {
    sent.push(args);
  };
  const done = (error: unknown) => {
    settled.push(error);
  };
  const view = await mount(h(StrictMode, null, h(Notice, { owner: 'one' })));
  let first!: Promise<void>;
  await act(() => {
    first = api.run(request, send, done);
    void api.run(request, send, done);
  });
  assert.equal(reads.requests.length, 1);
  await view.render(h(StrictMode, null, h(Notice, { owner: 'two' })));
  let second!: Promise<void>;
  await act(() => {
    second = api.run(request, send, done);
  });
  await act(async () => {
    reads.requests[0].resolve(result);
    await first;
  });
  assert.deepEqual(sent, []);
  assert.equal(api.busy, true);
  await act(async () => {
    reads.requests[1].resolve(result);
    await second;
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(settled, [null]);
  assert.equal(api.busy, false);
  let cancelled!: Promise<void>;
  await act(() => {
    cancelled = api.run(request, send, done);
    api.cancel();
  });
  await act(async () => {
    reads.requests[2].reject(new Error('retired'));
    await cancelled;
  });
  assert.deepEqual(settled, [null]);
  let disposed!: Promise<void>;
  await act(() => {
    disposed = api.run(request, send, done);
  });
  await view.unmount();
  reads.requests[3].resolve(result);
  await disposed;
  assert.equal(sent.length, 1);
});

test('failed reads, malformed results and rejected sends stay retryable without sending stale data', async () => {
  const view = await mount(h(Notice, { owner: 'one' }));
  const errors: unknown[] = [],
    sent: unknown[] = [];
  for (const value of [
    null,
    {},
    { message: '' },
    { ...result, precondition: null },
    { ...result, precondition: { url: 'other', token: 'x' } },
  ]) {
    read = async () => value;
    await act(() =>
      api.run(
        request,
        async (message) => {
          sent.push(message);
        },
        (error) => errors.push(error),
      ),
    );
    assert.equal(api.busy, false);
  }
  read = async () => {
    throw new Error('read failed');
  };
  await act(() =>
    api.run(
      request,
      async () => {},
      (error) => errors.push(error),
    ),
  );
  assert.equal(errors.at(-1), 'Could not resume the task: read failed');
  assert.deepEqual(sent, []);
  read = async () => result;
  await act(() =>
    api.run(
      request,
      async () => false,
      (error) => errors.push(error),
    ),
  );
  assert.match(String(errors.at(-1)), /Could not resume/);
  const wait = deferred();
  let sending!: Promise<void>;
  await act(() => {
    sending = api.run(
      request,
      () => wait.promise,
      (error) => errors.push(error),
    );
  });
  await view.render(h(Notice, { owner: null }));
  await act(async () => {
    wait.reject(new Error('old send'));
    await sending;
  });
  const count = errors.length;
  await act(() =>
    api.run(
      request,
      async () => {},
      (error) => errors.push(error),
    ),
  );
  assert.equal(errors.length, count);
  await view.render(h(Notice, { owner: 'retry' }));
  await act(() =>
    api.run(
      request,
      async () => true,
      (error) => errors.push(error),
    ),
  );
  assert.equal(errors.at(-1), null);
  await view.unmount();
});

test('retained failure keeps its notice without duplicating input; healthy queued acceptance settles once', async () => {
  read = async () => result;
  const view = await mount(h(Notice, { owner: 'retained' }));
  const errors: unknown[] = [];
  let sends = 0;
  const send = async (_text: string, _precondition: any, received: any) => {
    sends++;
    received({ action: 'queued', id: 'retained-id', error: 'controller changed' });
    return true;
  };
  await act(() => api.run(request, send, (error) => errors.push(error)));
  assert.equal(api.retained, true);
  assert.match(String(errors.at(-1)), /^Still queued\. Remove it below before retrying\.$/);
  await act(() => api.run(request, send, (error) => errors.push(error)));
  assert.equal(sends, 1);
  await view.render(h(Notice, { owner: 'healthy' }));
  assert.equal(api.retained, false);
  await act(() =>
    api.run(
      request,
      async (_text, _precondition, received) => {
        sends++;
        received({ action: 'queued', id: 'healthy-id' });
        return true;
      },
      (error) => errors.push(error),
    ),
  );
  assert.equal(errors.at(-1), null);
  assert.equal(api.retained, false);
  assert.equal(sends, 2);
  await view.unmount();
});

test('exact-id recovery coalesces removal and retires late answers without inferring delivery from absence', async () => {
  read = async () => result;
  const view = await mount(h(Notice, { owner: 'recover' }));
  const errors: unknown[] = [],
    removed: unknown[] = [];
  const done = (error: unknown) => {
    errors.push(error);
  };
  const retain = async (_text: string, _precondition: any, receive: any) => {
    receive({ action: 'queued', id: 'exact-id', error: 'changed' });
    return true;
  };
  await act(() => api.removeRetained('chat', done));
  assert.deepEqual(errors, []);
  await act(() => api.run(request, retain, done));
  for (const answer of [false, null, undefined, {}, 'removed']) {
    remove = async (...args) => {
      removed.push(args);
      return answer as any;
    };
    await act(() => api.removeRetained('chat', done));
    assert.equal(api.retained, true);
  }
  assert.equal(api.retained, true);
  assert.match(String(errors.at(-1)), /no longer queued/);
  assert.deepEqual(
    removed,
    Array.from({ length: 5 }, () => ['chat', 'exact-id']),
  );
  remove = async () => {
    throw new Error('unavailable');
  };
  await act(() => api.removeRetained('chat', done));
  assert.equal(api.retained, true);
  assert.match(String(errors.at(-1)), /unavailable/);
  const gate = deferred<boolean>();
  let calls = 0;
  remove = () => {
    calls++;
    return gate.promise;
  };
  let pending!: Promise<void>;
  await act(() => {
    pending = api.removeRetained('chat', done);
    void api.removeRetained('chat', done);
  });
  assert.equal(calls, 1);
  await act(async () => {
    gate.resolve(true);
    await pending;
  });
  assert.equal(api.retained, false);
  assert.equal(errors.at(-1), null);
  await act(() => api.run(request, retain, done));
  const late = deferred<boolean>();
  remove = () => late.promise;
  await act(() => {
    pending = api.removeRetained('chat', done);
  });
  await view.render(h(Notice, { owner: 'replacement' }));
  const count = errors.length;
  await act(async () => {
    late.resolve(true);
    await pending;
  });
  assert.equal(errors.length, count);
  assert.equal(api.retained, false);
  await act(() => api.run(request, retain, done));
  const rejected = deferred<boolean>();
  remove = () => rejected.promise;
  await act(() => {
    pending = api.removeRetained('chat', done);
  });
  await view.unmount();
  rejected.reject(new Error('retired'));
  await pending;
  assert.equal(errors.length, count + 1);
});
