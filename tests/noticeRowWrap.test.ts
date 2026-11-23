// The rows stacked above and below a chat's transcript (the account banners, the notice in place of the composer, a
// chat's error and retry rows) wrap their actions under their text in a narrow pane, through the full app stylesheet.
// A row whose actions keep one line beside text that may shrink to nothing squeezed the gave-up banner to a letter a
// line, thousands of pixels tall, so the transcript between it and the down notice had no height: the first turn of a
// chat read from disk never rendered (#2119) and the chat's Retry sat under the notice (#2120). docs/bug-prevention/edge-states.md
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appCss } from './support/app-css.ts';
import { setup, resetCtl, defaultState, useStore, render } from './support/settings-harness.ts';

export const GUARDS = ['src/'];

await setup();
const { createElement: h } = await import('react');
const { AccountExpiredBanner } = await import('../src/components/accounts/Accounts.tsx');

const style = document.createElement('style');
style.textContent = appCss();
before(() => document.head.append(style));
after(() => style.remove());
beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});

/** The flex of each row's text class, as the app stylesheet writes it (its last rule naming the class alone). */
const TEXT_RULES = new Map(
  ['acct-banner-text', 'elsewhere-text', 'turn-stall-text'].map((c) => {
    const rules = [
      ...appCss()
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .matchAll(new RegExp(`(?:^|\\})\\s*\\.${c}\\s*\\{([^}]*)\\}`, 'g')),
    ];
    return [c, /(?:^|;)\s*flex:\s*([^;]+);/.exec(rules.at(-1)?.[1] ?? '')?.[1]?.trim()] as const;
  }),
);

/** The row's actions keep together at its end and wrap among themselves, so not even their own line overflows. */
function actionsWrap(actions: Element, label: string) {
  const css = getComputedStyle(actions);
  assert.equal(css.flexWrap, 'wrap', `${label}'s actions wrap among themselves`);
  assert.equal(css.minWidth, '0', `${label}'s actions can be narrower than their one line`);
  assert.equal(css.marginLeft, 'auto', `${label}'s actions keep to the row's end`);
  assert.equal(css.justifyContent, 'flex-end');
}

/** Happy DOM computes the cascade, not pixels: the rule that keeps the text readable is the row's wrap and the text's basis. */
function wrapsUnderText(row: Element, text: Element | null, label: string) {
  assert.equal(getComputedStyle(row).flexWrap, 'wrap', `${label} wraps its actions onto a line of their own`);
  if (!text) return;
  // Happy DOM drops a flex shorthand with min(), so the text's own rule is read as written
  const cls = [...text.classList].find((c) => TEXT_RULES.has(c));
  assert.ok(cls, `${label}'s text is one of the rows' text classes`);
  assert.equal(
    TEXT_RULES.get(cls),
    '1 1 min(16em, 50%)',
    `${label}'s text keeps 16em (or half a narrower row) before the actions wrap, and grows`,
  );
  assert.equal(getComputedStyle(text).minWidth, '0');
}

test("the gave-up banner's text keeps a readable width: its actions wrap under it in a narrow pane (#2119, #2120)", async () => {
  useStore.setState({
    codexRestart: 'gaveUp',
    codexQuit: {
      copy: { path: '/Users/runner/work/repo/repo/tests/e2e/fixtures/fake-codex.mjs', version: '0.162.0', via: null, from: null },
      pinned: true,
    },
    connError: 'Codex app-server exited (1).',
  });
  const r = await render(h(AccountExpiredBanner));
  try {
    const banner = r.host.querySelector('.acct-banner[role=alert]')!;
    const text = banner.querySelector(':scope > .acct-banner-text');
    assert.ok(text, 'the text is its own flex item');
    assert.match(text.textContent ?? '', /keeps quitting, so MoPilot stopped restarting it\. It's the copy you picked\./);
    wrapsUnderText(banner, text, 'the gave-up banner');
    assert.equal(getComputedStyle(text).overflowWrap, 'anywhere', 'a long binary path still breaks');
    // no spacer competes with the text for the room left: the text grows into it
    assert.equal(banner.querySelector(':scope > span[style]'), null);
    const actions = banner.querySelector(':scope > .acct-banner-actions')!;
    actionsWrap(actions, 'the gave-up banner');
    assert.deepEqual(
      [...actions.querySelectorAll(':scope > button')].map((b) => b.textContent?.trim()),
      ['Use another Codex', 'Copy crash output', 'Restart Codex'],
    );
    // the stack of banners keeps to a share of the window, scrolling past it
    const stack = getComputedStyle(banner.parentElement!);
    assert.equal(banner.parentElement!.className, 'acct-banners');
    assert.equal(stack.maxHeight, `${(window.innerHeight * 30) / 100}px`, 'at most 30% of the window');
    assert.equal(stack.overflowY, 'auto');
    assert.equal(stack.flexShrink, '0');
    for (const b of actions.querySelectorAll(':scope > button')) {
      assert.equal(getComputedStyle(b).whiteSpace, 'nowrap', `${b.textContent} keeps its one-line label`);
      assert.equal(getComputedStyle(b).flexShrink, '0');
    }
  } finally {
    await r.unmount();
  }
});

test('the Restarting banner wraps the same way', async () => {
  useStore.setState({ codexRestart: { attempt: 2 } as any });
  const r = await render(h(AccountExpiredBanner));
  try {
    const banner = r.host.querySelector('.acct-banner[role=status]')!;
    assert.match(banner.textContent ?? '', /Codex quit\. Restarting it \(try 2\)…/);
    wrapsUnderText(banner, banner.querySelector(':scope > .acct-banner-text'), 'the restarting banner');
  } finally {
    await r.unmount();
  }
});

test("the notice in place of the composer, a chat's error and its retry and stall rows wrap their actions too", () => {
  const host = document.createElement('div');
  host.innerHTML = [
    '<div class="elsewhere-notice"><span class="elsewhere-icon"></span><div class="elsewhere-text">Codex isn\'t running</div><div class="elsewhere-actions"><button class="btn-pill">Restart Codex</button></div></div>',
    '<div class="error-banner"><span class="error-banner-text">Codex isn\'t connected</span><button class="btn-pill soft">Retry</button></div>',
    '<div class="retry-banner turn-stall"><div class="turn-stall-text">No progress</div><div class="turn-stall-actions"><button>Stop</button></div></div>',
  ].join('');
  document.body.append(host);
  try {
    const notice = host.querySelector('.elsewhere-notice')!;
    wrapsUnderText(notice, notice.querySelector('.elsewhere-text'), 'the down notice');
    actionsWrap(notice.querySelector('.elsewhere-actions')!, 'the down notice');
    const error = host.querySelector('.error-banner')!;
    wrapsUnderText(error, null, "a chat's read error");
    // an error carrying a path breaks anywhere rather than push Retry out of the column
    const errorText = getComputedStyle(error.querySelector('.error-banner-text')!);
    assert.equal(errorText.minWidth, '0');
    assert.equal(errorText.overflowWrap, 'anywhere');
    const stall = host.querySelector('.turn-stall')!;
    wrapsUnderText(stall, stall.querySelector('.turn-stall-text'), 'the stall row');
    actionsWrap(stall.querySelector('.turn-stall-actions')!, 'the stall row');
  } finally {
    host.remove();
  }
});

/** Each class token on an element in `text`: every literal className, and the literal parts of a template one. */
function classTokens(text: string): string[][] {
  return [...text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => (m[1] ?? m[2]).split(/\s+/));
}

test('every row stacked around a transcript names its text, so the rule that keeps it readable reaches it (whole repository)', () => {
  // the row's class, and the class its text must carry
  const rows = [
    ['acct-banner', 'acct-banner-text'],
    ['elsewhere-notice', 'elsewhere-text'],
    ['turn-stall', 'turn-stall-text'],
  ];
  const src = new URL('../src/', import.meta.url);
  const seen = new Map(rows.map(([row]) => [row, 0]));
  for (const file of fs.readdirSync(src, { recursive: true }) as string[]) {
    if (!file.endsWith('.tsx')) continue;
    const text = fs.readFileSync(new URL(file, src), 'utf8');
    const tokens = classTokens(text);
    for (const [row, inner] of rows) {
      const count = (c: string) => tokens.filter((t) => t.includes(c)).length;
      seen.set(row, seen.get(row)! + count(row));
      assert.equal(count(inner), count(row), `${file}: each .${row} has one .${inner} for its text`);
    }
    // a spacer beside the text would take the room it grows into
    for (const m of text.matchAll(/className="acct-banner"[\s\S]*?<\/div>/g))
      assert.doesNotMatch(m[0], /<span style=\{\{ flex: 1 \}\} \/>/, `${file}: no spacer in an .acct-banner`);
  }
  for (const [row, n] of seen) assert.ok(n > 0, `the scan finds the .${row} rows`);
});

test('the scan reads literal and template classNames', () => {
  assert.deepEqual(classTokens('<div className="acct-banner" /><span className={`acct-banner-text ${x}`} />'), [
    ['acct-banner'],
    ['acct-banner-text', '${x}'],
  ]);
});
