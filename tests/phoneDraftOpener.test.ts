// How the phone opens a MoMo draft (mobile/src/momo/draftOpener.ts): Gmail's own compose link when Gmail is installed (iOS gives Gmail's inbox for a mailto: link when Gmail is the default mail app), else the mail link, else the share sheet; the first that opens wins, a refusal passes to the next, the button says what its first step does, and the build declares the Gmail scheme so iOS answers whether Gmail is installed. Nothing here sends.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  GMAIL_PROBE,
  MAX_GMAIL,
  gmailUrlOf,
  isPick,
  planOf,
  runPlan,
  shareTextOf,
  stepsFor,
  viewOf,
  wordOf,
} from '../mobile/src/momo/draftOpener.ts';
import { createDraftPick } from '../mobile/src/momo/draftPick.ts';

const require = createRequire(import.meta.url);
const DRAFT = { to: ['sam@example.com', 'lee+x@example.com'], subject: 'Re: lunch & more', body: 'Friday works.\nNoon?' };

test('Gmail’s link carries every recipient, the subject and the body, percent-encoded', () => {
  assert.equal(
    gmailUrlOf(DRAFT),
    'googlegmail:///co?to=sam%40example.com,lee%2Bx%40example.com&subject=Re%3A%20lunch%20%26%20more&body=Friday%20works.%0ANoon%3F',
  );
  // no recipient and no subject: the body alone
  assert.equal(gmailUrlOf({ to: [], subject: '', body: 'x' }), 'googlegmail:///co?to=&body=x');
  assert.equal(GMAIL_PROBE, 'googlegmail://');
});

test('a draft whose Gmail link is over the cap has none', () => {
  const body = 'x'.repeat(MAX_GMAIL - 'googlegmail:///co?to=&body='.length);
  assert.equal(gmailUrlOf({ to: [], subject: '', body })!.length, MAX_GMAIL);
  assert.equal(gmailUrlOf({ to: [], subject: '', body: `${body}x` }), null);
});

test('the plan is Gmail when it is installed, then the mail link, then the share sheet, which is always there', () => {
  const gmail = planOf(DRAFT, true);
  assert.deepEqual(
    gmail.map((s) => s.via),
    ['gmail', 'mail', 'share'],
  );
  assert.match((gmail[0] as any).url, /^googlegmail:\/\/\/co\?to=/);
  assert.match((gmail[1] as any).url, /^mailto:sam@example\.com,lee%2Bx@example\.com\?subject=/);
  assert.deepEqual(
    planOf(DRAFT, false).map((s) => s.via),
    ['mail', 'share'],
    'Gmail not installed, or iOS not told it may ask',
  );
  // a long draft has no link to open, so the sheet carries it
  const long = { to: [], subject: '', body: 'word '.repeat(600) };
  assert.deepEqual(planOf(long, true), [{ via: 'share' }]);
});

const LONG = { to: [], subject: '', body: 'word '.repeat(600) };

test('without Gmail the mail link is the one tap and there is no chooser; with a draft too long for a link it is Share', () => {
  assert.deepEqual(viewOf(DRAFT, false, null), { options: ['mail', 'share'], choose: false, forget: false, primary: 'mail' });
  // a remembered pick is ignored while there is no Gmail to choose over, and a remembered Gmail is dropped
  assert.equal(viewOf(DRAFT, false, 'share').primary, 'mail');
  assert.deepEqual(viewOf(DRAFT, false, 'gmail'), { options: ['mail', 'share'], choose: false, forget: true, primary: 'mail' });
  assert.deepEqual(viewOf(LONG, false, null), { options: ['share'], choose: false, forget: false, primary: 'share' });
});

test('with Gmail installed the person chooses: no one tap until a pick, then the pick is the tap', () => {
  assert.deepEqual(viewOf(DRAFT, true, null), { options: ['gmail', 'mail', 'share'], choose: true, forget: false, primary: null });
  for (const pick of ['gmail', 'mail', 'share'] as const) assert.equal(viewOf(DRAFT, true, pick).primary, pick);
  // a draft too long for a link is shared, whatever was picked, and the pick is kept for the next draft
  assert.deepEqual(viewOf(LONG, true, 'gmail'), { options: ['share'], choose: false, forget: false, primary: 'share' });
  // a draft with a mail link that fits but no Gmail link that fits: the chooser offers Mail and Share, and a remembered Gmail is not the tap
  const edge = { to: [], subject: '', body: 'x'.repeat(1980) };
  assert.deepEqual(viewOf(edge, true, 'gmail'), { options: ['mail', 'share'], choose: true, forget: false, primary: null });
});

test('the button names what its one tap does, or that it asks', () => {
  assert.equal(wordOf('gmail'), 'openInGmail');
  assert.equal(wordOf('mail'), 'openInMail');
  assert.equal(wordOf('share'), 'share');
  assert.equal(wordOf(null), 'openChoose');
});

test('a pick is tried first and the others follow in the default order; no pick is the default order', () => {
  const via = (pick: any) => stepsFor(DRAFT, true, pick).map((s) => s.via);
  assert.deepEqual(via(null), ['gmail', 'mail', 'share']);
  assert.deepEqual(via('mail'), ['mail', 'gmail', 'share']);
  assert.deepEqual(via('share'), ['share', 'gmail', 'mail']);
  assert.deepEqual(stepsFor(LONG, true, 'gmail'), [{ via: 'share' }], 'a pick with nothing to open is left out');
  assert.equal(isPick('gmail') && isPick('mail') && isPick('share'), true);
  assert.equal(isPick('send') || isPick(null) || isPick(3), false);
});

test('the pick is kept in the phone’s own store: read back, dropped, and never thrown on', async () => {
  let kept: string | null = null;
  const store = {
    read: async () => kept,
    write: async (v: string | null) => void (kept = v),
  };
  const pick = createDraftPick(store);
  assert.equal(await pick.get(), null);
  assert.equal(await pick.set('gmail'), true);
  assert.equal(kept, 'gmail');
  assert.equal(await pick.get(), 'gmail');
  await pick.forget();
  assert.equal(kept, null);
  // something else in the store is no pick, a store that fails reads as none, a write that fails says so
  kept = 'send';
  assert.equal(await pick.get(), null);
  const broken = createDraftPick({
    read: async () => {
      throw new Error('keychain locked');
    },
    write: async () => {
      throw new Error('keychain locked');
    },
  });
  assert.equal(await broken.get(), null);
  assert.equal(await broken.set('mail'), false);
  await broken.forget();
});

test('the share sheet carries who it is for, the subject and the words', () => {
  assert.equal(shareTextOf(DRAFT), 'To: sam@example.com, lee+x@example.com\n\nSubject: Re: lunch & more\n\nFriday works.\nNoon?');
  assert.equal(shareTextOf({ to: [], subject: '', body: 'b' }), 'b');
});

test('the first step that opens wins; a refusal passes to the next; none opening says so', async () => {
  const log: string[] = [];
  const io = (refuse: string[]) => ({
    open: async (url: string) => {
      log.push(url.split(':')[0]);
      if (refuse.includes(url.split(':')[0])) throw new Error('cannot open');
    },
    share: async (text: string) => {
      log.push('share');
      if (refuse.includes('share')) throw new Error('no sheet');
      assert.match(text, /Friday works\./);
    },
  });
  const plan = planOf(DRAFT, true);
  assert.deepEqual(await runPlan(plan, DRAFT, io([])), plan[0]);
  assert.deepEqual(log.splice(0), ['googlegmail']);
  assert.deepEqual(await runPlan(plan, DRAFT, io(['googlegmail'])), plan[1]);
  assert.deepEqual(log.splice(0), ['googlegmail', 'mailto']);
  assert.deepEqual(await runPlan(plan, DRAFT, io(['googlegmail', 'mailto'])), plan[2]);
  assert.deepEqual(log.splice(0), ['googlegmail', 'mailto', 'share']);
  assert.equal(await runPlan(plan, DRAFT, io(['googlegmail', 'mailto', 'share'])), null);
});

test('the build declares Gmail’s scheme so iOS answers whether Gmail is installed, in every profile', () => {
  const app = require('../mobile/app.json');
  assert.deepEqual(app.expo.ios.infoPlist.LSApplicationQueriesSchemes, ['googlegmail']);
  const config = require('../mobile/app.config.js');
  for (const env of [{}, { MOPILOT_DEV_HOST: 'http://192.168.1.2:8787' }]) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const made = config({ config: app.expo });
      assert.deepEqual(made.ios.infoPlist.LSApplicationQueriesSchemes, ['googlegmail'], JSON.stringify(env));
    } finally {
      process.env = saved;
    }
  }
});
