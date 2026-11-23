// Account avatars that tell listed accounts apart, and the usage meters every account surface shares.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { avatarLabels, avatarColor, initialsOf, AccountAvatar } = await import('../src/components/accounts/presentation.tsx');
const { LimitMeters } = await import('../src/components/accounts/meters.tsx');
const { resetText } = await import('../src/harness/usageWindows.ts');

test('accounts whose emails start alike get initials from where they differ', () => {
  const got = avatarLabels(['dax0.reg@example.test', 'daxhill6@example.test', 'dax3.reg@example.test', 'dax4.reg@example.test']);
  assert.deepEqual(
    got.map((l) => l.initials),
    ['D0', 'DH', 'D3', 'D4'],
  );
  // every color differs while the palette lasts
  assert.equal(new Set(got.map((l) => l.color)).size, 4);
});

test('an account alone, or unlike the others, keeps its usual initials and color', () => {
  assert.deepEqual(avatarLabels(['me@example.com']), [{ initials: initialsOf('me@example.com'), color: avatarColor('me@example.com') }]);
  assert.deepEqual(
    avatarLabels(['me@example.com', 'you@example.com']).map((l) => l.initials),
    ['ME', 'YO'],
  );
  // no email: the key's own label, and it never collides with anything
  assert.deepEqual(
    avatarLabels([null, 'api@example.com']).map((l) => l.initials),
    ['API', 'AP'],
  );
});

test('same local part at different domains differs by domain; identical emails keep their initials', () => {
  assert.deepEqual(
    avatarLabels(['a@x.com', 'a@y.com']).map((l) => l.initials),
    ['AX', 'AY'],
  );
  assert.deepEqual(
    avatarLabels(['same@x.com', 'same@x.com']).map((l) => l.initials),
    ['SA', 'SA'],
  );
  // alike initials, but the emails differ at their first character: nothing shorter tells them apart
  assert.deepEqual(
    avatarLabels(['1ab@x.com', 'ab@x.com']).map((l) => l.initials),
    ['AB', 'AB'],
  );
});

test('colors repeat only once every color is taken', () => {
  const emails = Array.from({ length: 8 }, (_, i) => `person${i}@example.com`);
  const colors = avatarLabels(emails).map((l) => l.color);
  assert.equal(new Set(colors.slice(0, 6)).size, 6);
  assert.equal(new Set(colors).size, 6);
});

test('an avatar shows the given label, or the account as it reads alone', () => {
  assert.match(
    renderToStaticMarkup(h(AccountAvatar, { account: { email: 'me@example.com' }, label: { initials: 'Z9', color: '#123456' } })),
    /background:#123456.*>Z9</,
  );
  assert.match(renderToStaticMarkup(h(AccountAvatar, { account: { email: 'me@example.com' } })), />ME</);
  // alone, an unverified login reads "?", a login with no email yet "?", and only a key "API" (#1930)
  assert.match(renderToStaticMarkup(h(AccountAvatar, { account: { email: 'me@example.com', unverified: true } })), />\?</);
  assert.match(renderToStaticMarkup(h(AccountAvatar, { account: { email: null, kind: 'chatgpt' } })), />\?</);
  assert.match(renderToStaticMarkup(h(AccountAvatar, { account: { email: null, kind: 'apiKey' } })), />API</);
});

const w = (label: string, usedPercent: number, p: any = {}) => ({ label, usedPercent, resetsAt: null, ...p });

test('meters say what is left: inline with "left", compact without, at most two side by side', () => {
  assert.equal(renderToStaticMarkup(h(LimitMeters, { windows: [] })), '');
  const html = renderToStaticMarkup(h(LimitMeters, { windows: [w('5h', 20), w('Weekly', 90), w('Weekly Opus', 100)] }));
  assert.match(html, /5h.*80% left.*Weekly.*10% left/);
  assert.doesNotMatch(html, /Opus/);
  assert.match(html, /class="low"/);
  const compact = renderToStaticMarkup(h(LimitMeters, { windows: [w('5h', 20.4)], variant: 'compact' }));
  assert.match(compact, /hp-meters compact/);
  assert.match(compact, />80%</);
  assert.doesNotMatch(compact, /left/);
});

test('detailed meters show each window with its percent left, a toned bar and when it resets', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000_000 });
  try {
    const html = renderToStaticMarkup(
      h(LimitMeters, {
        variant: 'detail',
        windows: [w('5h', 0, { resetsAt: 1_000_000 + 2 * 3600 }), w('Weekly', 90, { resetsText: 'Mon 9:00' }), w('Weekly Opus', 100)],
      }),
    );
    assert.match(html, /5h.*100% left.*class="limit-fill ".*Resets in 2h 0m/);
    assert.match(html, /Weekly.*10% left.*limit-fill low.*Resets Mon 9:00/);
    assert.match(html, /Weekly Opus.*0% left.*limit-fill out/);
    assert.equal(html.split('limit-reset').length - 1, 2);
  } finally {
    mock.timers.reset();
  }
});

test('the reset line prefers an exact time, then the text the CLI gave, else nothing', () => {
  assert.equal(resetText(w('5h', 1)), null);
  assert.equal(resetText(w('5h', 1, { resetsText: 'soon' })), 'Resets soon');
});

test('a window whose reset passed since it was read shows no figure, never a full bar (#1582)', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
  try {
    const past = w('Weekly', 100, { resetsAt: 1_000_000_000 - 60 });
    const ahead = w('5h', 40, { resetsAt: 1_000_000_000 + 3600 });
    const detail = renderToStaticMarkup(h(LimitMeters, { windows: [past, ahead], variant: 'detail' }));
    assert.doesNotMatch(detail, /Weekly<\/span><span class="limit-left">100% left/);
    assert.match(
      detail,
      /Weekly<\/span><span class="limit-left">—<\/span><\/div><div class="limit-bar"><\/div><div class="limit-reset">Reset since last read/,
    );
    assert.match(detail, /5h<\/span><span class="limit-left">60% left/);
    const inline = renderToStaticMarkup(h(LimitMeters, { windows: [past] }));
    assert.match(inline, /title="Reset since last read".*Weekly.*<span class="hp-bar"><\/span><span>—<\/span>/);
    assert.match(renderToStaticMarkup(h(LimitMeters, { windows: [past], variant: 'compact' })), /<span>—<\/span>/);
  } finally {
    mock.timers.reset();
  }
});

test("the context panel's rows are flush: name and reset, a thin toned bar, and what is left; a passed reset shows no figure", () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
  try {
    const html = renderToStaticMarkup(
      h(LimitMeters, {
        variant: 'rows',
        windows: [
          w('5h', 9, { resetsAt: 1_000_000_000 + 2 * 3600 }),
          w('Weekly', 90),
          w('Weekly Fable', 100, { resetsAt: 1_000_000_000 - 60 }),
        ],
      }),
    );
    assert.match(html, /^<div class="limit-rows">/);
    assert.match(
      html,
      /<div class="limit-row-name"><span>5h<\/span><span class="limit-row-reset">Resets in 2h 0m · [^<]+<\/span><\/div><div class="limit-row-bar"><i class="" style="width:91%"><\/i><\/div><span class="limit-row-left">91% left<\/span>/,
    );
    assert.match(html, /<span>Weekly<\/span><\/div><div class="limit-row-bar"><i class="low"/);
    assert.match(
      html,
      /<span>Weekly Fable<\/span><span class="limit-row-reset">Reset since last read<\/span><\/div><div class="limit-row-bar"><\/div><span class="limit-row-left">—<\/span>/,
    );
  } finally {
    mock.timers.reset();
  }
});
