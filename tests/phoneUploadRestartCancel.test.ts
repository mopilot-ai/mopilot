// An upload that starts over after the Mac forgot its stream still honours a Cancel that lands while the restarted run finishes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../tests/support/phone/register.ts';
// loaded after the native-module aliases are registered
const uploadPath = '../mobile/src/remote/upload.ts';
const { CHUNK, Cancelled, sendChunks } = await import(uploadPath);

test('a cancel that lands as the restarted run completes rejects with Cancelled instead of reporting success', async () => {
  const sent: number[] = [];
  let failedOnce = false;
  const request: any = async (_method: string, p: any) => {
    sent.push(p.index);
    if (!failedOnce) {
      failedOnce = true;
      throw new Error('Send that upload again from the start.');
    }
    return { stream: p.stream, received: p.index + 1, done: p.index + 1 === p.total };
  };
  const stop = new AbortController();
  const resume = { stream: 'forgotten-stream', next: 1 };
  const file = { name: 'p.jpg', mime: 'image/jpeg', base64: 'A'.repeat(CHUNK + 4) };
  const progress: number[] = [];
  await assert.rejects(
    sendChunks(
      request,
      file,
      'file',
      (done: number) => {
        progress.push(done);
        // the restarted run confirms its last part, then the user cancels before it returns
        if (done === 2 && failedOnce) stop.abort();
      },
      stop.signal,
      resume,
    ),
    Cancelled,
  );
  // the first run failed on part 1; the restarted run went through both parts under a new stream
  assert.deepEqual(sent, [1, 0, 1]);
  assert.deepEqual(progress, [1, 0, 1, 2]);
  assert.notEqual(resume.stream, 'forgotten-stream');
  assert.equal(stop.signal.aborted, true);
});
