// The warm title CLI per login (electron/harness/claude/titleHelper.cjs, #3413), against a fake Agent SDK: one lean CLI per
// login and binary, reused while it is up, let go when idle, on a failure or when its CLI exits; a CLI too old to write
// titles, or none installed, answers null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';

const { createTitleHelper } = createRequire(import.meta.url)('../electron/harness/claude/titleHelper.cjs');

const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean) {
  await waitFor(ok, what);
  assert.ok(ok(), `timed out waiting for ${what}`);
}

/** A fake SDK whose CLIs run until their prompt ends (or `exit()`), answering title requests with `answer`. */
function fakeSdk(answer: ((text: string, o: any) => Promise<unknown>) | null = async (text) => `Title: ${text}`) {
  const started: any[] = [];
  const sdk = async () => ({
    query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: any }) => {
      let quit = () => {};
      const exited = new Promise<void>((r) => (quit = r));
      const q: any = {
        options,
        ended: false,
        asked: [] as any[],
        exit: () => quit(),
        async *[Symbol.asyncIterator]() {
          await Promise.race([
            exited,
            (async () => {
              for await (const _m of prompt);
            })(),
          ]);
          q.ended = true;
        },
      };
      if (answer) q.generateSessionTitle = (text: string, o: any) => (q.asked.push([text, o]), answer(text, o));
      started.push(q);
      return q;
    },
  });
  return { sdk, started };
}

const lean = async (account: string | undefined, bin: string | undefined) => ({ model: 'haiku', account, bin });

test("one warm CLI per login and binary writes each chat's title unsaved, and is reused while it is up", async () => {
  const { sdk, started } = fakeSdk();
  const helper = createTitleHelper({ sdk, options: lean });
  helper.warm('a1', undefined);
  await until('the warm CLI', () => started.length === 1);
  assert.deepEqual(started[0].options, { model: 'haiku', account: 'a1', bin: undefined });
  assert.equal(await helper.title('fix the login bug', 'a1', undefined), 'Title: fix the login bug');
  assert.equal(await helper.title('second chat', 'a1', undefined), 'Title: second chat');
  assert.equal(started.length, 1, 'the warm CLI is reused');
  assert.deepEqual(started[0].asked, [
    ['fix the login bug', { persist: false }],
    ['second chat', { persist: false }],
  ]);
  // another login, or another binary, has a CLI of its own
  await helper.title('x', 'a2', undefined);
  await helper.title('x', 'a1', '/other/claude');
  assert.equal(started.length, 3);
  helper.closeAll();
  await until('every CLI to end', () => started.every((q) => q.ended));
});

test('a CLI too old to write titles, a blank answer or no CLI installed answers null', async () => {
  const old = fakeSdk(null);
  assert.equal(await createTitleHelper({ sdk: old.sdk, options: lean }).title('x', 'a1'), null);
  const blank = fakeSdk(async () => '   ');
  assert.equal(await createTitleHelper({ sdk: blank.sdk, options: lean }).title('x', 'a1'), null);
  const none = fakeSdk();
  assert.equal(await createTitleHelper({ sdk: none.sdk, options: async () => null }).title('x', 'a1'), null);
  assert.equal(none.started.length, 0, 'no CLI starts without a binary');
});

test('a failed title request keeps the CLI up, so a CLI that refuses the request is not started for every chat', async () => {
  let fail = true;
  const { sdk, started } = fakeSdk(async (text) => {
    if (fail) throw new Error('Unknown control request');
    return text;
  });
  const helper = createTitleHelper({ sdk, options: lean });
  await assert.rejects(helper.title('x', 'a1'), /Unknown control request/);
  await assert.rejects(helper.title('x', 'a1'), /Unknown control request/);
  fail = false;
  assert.equal(await helper.title('y', 'a1'), 'y');
  assert.equal(started.length, 1);
  helper.closeAll();
});

test('a billing change starts a CLI of its own for the login', async () => {
  const { sdk, started } = fakeSdk();
  let billing = 'subscription';
  const helper = createTitleHelper({ sdk, options: lean, sig: () => billing });
  await helper.title('x', 'a1');
  billing = 'api-key';
  await helper.title('x', 'a1');
  await helper.title('y', 'a1');
  assert.equal(started.length, 2);
  helper.closeAll();
});

test('a CLI that exits, or one the SDK could not start, is let go', async () => {
  const { sdk, started } = fakeSdk();
  const helper = createTitleHelper({ sdk, options: lean });
  await helper.title('x', 'a1');
  started[0].exit();
  await until('its end', () => started[0].ended);
  await helper.title('y', 'a1');
  assert.equal(started.length, 2, 'a new CLI after the old one exited');
  helper.closeAll();

  let refuse = true;
  const flaky = createTitleHelper({
    sdk: async () => {
      if (refuse) throw new Error('sdk missing');
      return sdk();
    },
    options: lean,
  });
  // a warm that fails is noted, never thrown
  flaky.warm('a1');
  await wait();
  await assert.rejects(flaky.title('x', 'a1'), /sdk missing/);
  refuse = false;
  assert.equal(await flaky.title('z', 'a1'), 'Title: z');
  flaky.closeAll();
});

test('a CLI no title asked of for its idle time ends; asking again restarts the clock', async () => {
  const { sdk, started } = fakeSdk();
  const helper = createTitleHelper({ sdk, options: lean, idleMs: 40 });
  await helper.title('x', 'a1');
  await wait(20);
  // a use within the idle time keeps it up
  await helper.title('y', 'a1');
  await wait(25);
  assert.equal(started[0].ended, false);
  await until('the idle end', () => started[0].ended);
  await helper.title('z', 'a1');
  assert.equal(started.length, 2);
  helper.closeAll();
});
