// Stylesheet structure. A missing `}` is still valid CSS (it reads as nesting), so the build and
// typecheck pass while every rule after it silently stops applying. These checks catch that, and keep
// app.css a list of its area files (src/styles/app/) in a cascade order that only grows. It also keeps
// every looping animation answerable to the reduced-motion setting, and tabular figures on the counters
// that change while a diff or a review streams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import postcss from 'postcss';
import { treeFiles } from '../scripts/source-tree.mjs';
import { appCss, appCssParts, readAppCssPart } from './support/app-css.ts';
import { ALL_SHEETS, boxesClampedByASharedFloor, boxesOverTheirText, CHAT_SIZES } from './support/type-boxes.ts';
import { loopsWithNoMotionOptOut } from './support/motion-opt-out.ts';

export const GUARDS = ['src/'];

const parts = appCssParts();
const taskManifest = readFileSync(new URL('../src/styles/tasks.css', import.meta.url), 'utf8');
const taskParts = [...taskManifest.matchAll(/^@import '\.\/([\w/-]+\.css)';$/gm)].map((m) => m[1]);
const taskSheets = taskParts.map((part): [string, string] => [
  `src/styles/${part}`,
  readFileSync(new URL(`../src/styles/${part}`, import.meta.url), 'utf8'),
]);
const SHEETS: [string, string][] = [
  ['src/styles/app.css (all parts in order)', appCss()],
  ['src/styles/tokens.css', readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8')],
  ['src/styles/tasks.css (all parts in order)', taskSheets.map(([, text]) => text).join('')],
  ...taskSheets,
  ...parts.map((part): [string, string] => [`src/styles/${part}`, readAppCssPart(part)]),
];
const parse = (name: string, text: string) => postcss.parse(text, { from: name });

test('scrollable surfaces keep native overlay fading instead of painted WebKit scrollbars', () => {
  const painted: string[] = [];
  for (const name of treeFiles('src', /\.css$/)) {
    parse(name, readFileSync(name, 'utf8')).walkRules((rule) => {
      if (!rule.selectors.some((selector) => selector.includes('::-webkit-scrollbar'))) return;
      // Hiding a redundant rail is safe; sizing forces classic scrollbars and painting bypasses native appearance.
      rule.walkDecls((decl) => {
        if (decl.prop !== 'display' || decl.value !== 'none') painted.push(`${name}: ${rule.selector}: ${decl.toString()}`);
      });
    });
  }
  assert.deepEqual(painted, [], 'use scrollbar-width and scrollbar-color so the OS owns visibility and dragging');
});

test('shared native scrollbars are thin and use the current theme with a transparent track', () => {
  const values: Record<string, string> = {};
  parse('src/styles/app/base.css', readAppCssPart('app/base.css')).walkRules('*', (rule) => {
    rule.walkDecls((decl) => {
      values[decl.prop] = decl.value;
    });
  });
  assert.equal(values['scrollbar-width'], 'thin');
  assert.equal(values['scrollbar-color'], 'var(--scrollbar) transparent');
});

for (const [name, text] of SHEETS) {
  test(`${name}: no rule is nested inside another rule`, () => {
    const nested: string[] = [];
    parse(name, text).walkRules((rule) => {
      // this codebase doesn't use CSS nesting; a rule inside a rule means a block wasn't closed
      if (rule.parent?.type === 'rule')
        nested.push(`line ${rule.source?.start?.line}: "${rule.selector}" inside "${(rule.parent as postcss.Rule).selector}"`);
    });
    assert.deepEqual(nested, []);
  });
}

// The areas app.css was split into (docs/code-quality.md#stylesheets), in the original file's order. Their
// concatenation was the old app.css, so this order is the cascade the app was built and checked with: an
// earlier area must stay before a later one, or rules of equal specificity start overriding the other way.
// New areas may be inserted anywhere; renaming or removing one updates this list in the same change.
const SPLIT_ORDER = [
  'base',
  'titlebar',
  'sidebar-nav',
  'sidebar',
  'main',
  'home',
  'composer',
  'composer-content',
  'thread',
  'thread-messages',
  'thread-steps',
  'thread-inline-diff',
  'edited-files',
  'thread-tool-output',
  'thread-results',
  'markdown',
  'diff',
  'approvals',
  'thread-questions',
  'popovers',
  'summary-panel',
  'diff-panel',
  'terminal-panel',
  'palette',
  'toasts',
  'controls',
  'settings',
  'pages',
  'login',
  'control-cards',
  'sidebar-metrics',
  'composer-menus',
  'side-pane',
  'page-sidebars',
  'settings-extended',
  'scheduled-empty',
  'quick-chat',
  'project-hover-card',
  'voice',
  'codex-cloud',
  'files-pane',
  'browser-pane',
  'full-access-banner',
  'full-view',
  'settings-metrics',
  'sketch-pad',
  'thread-metrics',
  'schedule-dialog',
  'catalogs',
  'plugin-detail',
  'settings-plugins',
  'accounts',
  'harnesses',
  'motion',
  'usage',
  'onboarding',
  'harness-compat',
  'migration',
  'browser-sites',
  'scheduled-runs',
  'browser-tools',
];

test('app.css only imports its area files: no rules of its own', () => {
  const nodes = parse('src/styles/app.css', readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8')).nodes;
  const other = nodes.filter((n) => n.type !== 'comment' && !(n.type === 'atrule' && n.name === 'import'));
  assert.deepEqual(
    other.map((n) => n.toString().slice(0, 80)),
    [],
  );
  // every import is one the parts list reads (a quoted ./app/<area>.css on its own line)
  assert.equal(nodes.filter((n) => n.type === 'atrule').length, parts.length);
});

test('every file in src/styles/app/ is imported exactly once, and every import exists', () => {
  const files = readdirSync(new URL('../src/styles/app/', import.meta.url))
    .filter((f) => f.endsWith('.css'))
    .map((f) => `app/${f}`)
    .sort();
  assert.deepEqual([...parts].sort(), files);
  assert.equal(new Set(parts).size, parts.length);
});

test('each area file starts with a one-line header comment and imports nothing', () => {
  for (const part of parts) {
    const text = readAppCssPart(part);
    assert.match(text, /^\/\* [^\n]+ \*\/\n/, `${part} needs a one-line header comment`);
    assert.doesNotMatch(text, /@import/, `${part}: imports belong in app.css, in cascade order`);
    assert.ok(text.endsWith('\n'), `${part} must end with a newline, so the next part starts on its own line`);
  }
});

test('the areas split out of app.css keep their cascade order', () => {
  const order = parts.map((p) => p.replace(/^app\/|\.css$/g, '')).filter((name) => SPLIT_ORDER.includes(name));
  assert.deepEqual(order, SPLIT_ORDER);
});

// Classes the harness UI depends on; each must have a rule at the top level (or in a media query).
const REQUIRED = [
  'harness-icon',
  'chatgpt-mark',
  'hp-badge',
  'hp-meters',
  'hp-row',
  'hp-head',
  'switch-chip',
  'switch-sheet',
  'switch-divider',
  'status-note',
  'thread-harness',
  'hs-list',
  'api-chip',
  'hs-key-form',
];

test('harness UI classes have top-level styles', () => {
  const found = new Set<string>();
  parse('src/styles/app.css', appCss()).walkRules((rule) => {
    if (rule.parent?.type !== 'root' && rule.parent?.type !== 'atrule') return;
    for (const cls of rule.selector.match(/\.[\w-]+/g) ?? []) found.add(cls.slice(1));
  });
  assert.deepEqual(
    REQUIRED.filter((c) => !found.has(c)),
    [],
  );
});

/**
 * Counters whose digits change while a diff or a review streams, so proportional figures would shift the
 * text beside them on every update: each needs tabular figures from some rule that reaches it. The diff
 * gutters are not here -- they are monospace, where every digit already has the same advance.
 */
const TABULAR = [
  // the +N / -N change counts, wherever a diff is shown (the file card, the Changes pane, an inline diff,
  // the summary row, a pull request); every other rule for them only sets a size
  'diff-stat',
  // a review's "<level> · N findings", and the outcome line as fixes land
  'findings-meta',
  // one path:line per finding, in a column, as findings arrive
  'finding-loc',
  // the line range in a finding's annotation, held in place while the walk moves between findings
  'finding-annotation-lines',
];

/** The classes `css` puts tabular figures on, by a rule that reaches the element itself. */
function tabularClasses(name: string, css: string): Set<string> {
  const found = new Set<string>();
  parse(name, css).walkRules((rule) => {
    let on = false;
    rule.walkDecls('font-variant-numeric', (decl) => {
      on = decl.value.includes('tabular-nums');
    });
    if (!on) return;
    // the rightmost compound is the element the rule styles; an ancestor's figures are not inherited by name
    for (const selector of rule.selectors)
      for (const compound of selector.split(/\s+|>|\+|~/).slice(-1))
        for (const cls of compound.match(/\.[\w-]+/g) ?? []) found.add(cls.slice(1));
  });
  return found;
}

test('every counter that changes while a diff or a review streams has tabular figures', () => {
  const tabular = tabularClasses('src/styles/app.css', appCss());
  assert.deepEqual(
    TABULAR.filter((c) => !tabular.has(c)),
    [],
    'add font-variant-numeric: tabular-nums to the rule for this class',
  );
});

test('the tabular-figures guard reads the rule on the element, not one on an ancestor', () => {
  const at = (css: string) => [...tabularClasses('x.css', css)].sort();
  assert.deepEqual(at('.stat { font-variant-numeric: tabular-nums; }'), ['stat']);
  assert.deepEqual(at('.head .stat { font-variant-numeric: tabular-nums; }'), ['stat']);
  // a figure setting on a container is not what the counter inside it needs
  assert.deepEqual(at('.head { font-variant-numeric: tabular-nums; }\n.head .stat { font-size: 1em; }'), ['head']);
  // another font-variant-numeric value is not tabular figures
  assert.deepEqual(at('.stat { font-variant-numeric: oldstyle-nums; }'), []);
  assert.deepEqual(at('.stat { font-size: 1em; }'), []);
});

test('task styles keep pane rules before transcript/sidebar status rules and imports in the manifest', () => {
  assert.deepEqual(taskParts, ['tasks-pane.css', 'tasks-status.css']);
  const root = parse('src/styles/tasks.css', taskManifest);
  assert.ok(root.nodes.every((node) => node.type === 'comment' || (node.type === 'atrule' && node.name === 'import')));
  for (const [name, text] of taskSheets) {
    assert.match(text, /^\/\* [^\n]+ \*\/\n/, `${name} needs an ownership header`);
    assert.doesNotMatch(text, /@import/, `${name}: imports belong in the manifest`);
    assert.ok(text.endsWith('\n'), `${name} must end with a newline`);
  }
});

test('every stylesheet the app loads is read for pinned boxes, not only app.css', () => {
  const names = ALL_SHEETS.map(([name]) => name);
  assert.equal(new Set(names).size, names.length);
  // a stylesheet a component imports is as real as an area file (src/components/thread/prMonitor.module.css)
  for (const sheet of [
    'src/styles/app/controls.css',
    'src/styles/agents.css',
    'src/styles/tasks-pane.css',
    'src/components/thread/prMonitor.module.css',
  ])
    assert.ok(names.includes(sheet), sheet);
  assert.deepEqual([CHAT_SIZES.at(0), CHAT_SIZES.at(-1)], [12, 18]);
});

test('no rule pins a pixel height around text whose line box outgrows it at any Chat font size', () => {
  assert.deepEqual(
    boxesOverTheirText(ALL_SHEETS),
    [],
    'a box around type has to grow with it (min-height), or keep a leading that fits the box',
  );
});

test('the pinned-box guard reads the leading, the size, the padding and the border of each box', () => {
  const at = (css: string) => boxesOverTheirText([['x.css', css]]).map((m) => m.replace('x.css ', ''));
  // a 22px box holds a --fs-small line box at the inherited 1.5 (23.1px) at every size below Chat 18
  assert.deepEqual(at('.a { height: 22px; font-size: var(--fs-small); }'), [
    '.a: height 22px holds 23.14px at Chat 18 (font-size var(--fs-small), line-height 1.5)',
  ]);
  assert.deepEqual(at('.a { min-height: 22px; font-size: var(--fs-small); }'), []);
  // a leading that fits the box is the other way to hold it: --fs-ui at 1 never outgrows 23px
  assert.deepEqual(at('.a { height: 23px; font-size: var(--fs-ui); line-height: 1; }'), []);
  // the `font` shorthand resets an earlier leading in the same block, so the inherited 1.5 applies
  assert.deepEqual(at('.a { height: 23px; font-size: var(--fs-ui); line-height: 1; font: inherit; }').length, 1);
  // vertical padding and border count against the box, horizontal padding does not
  assert.deepEqual(at('.a { height: 29px; padding: 5px 8px; font-size: var(--fs-ui); }').length, 1);
  assert.deepEqual(at('.a { height: 29px; padding: 0 8px; font-size: var(--fs-ui); }'), []);
  // a 16px box holds --fs-micro at a leading of 1 (14.8px at Chat 18); two 1px borders do not fit
  assert.deepEqual(at('.a { height: 16px; border: 1px solid red; font-size: var(--fs-micro); line-height: 1; }').length, 1);
  assert.deepEqual(at('.a { height: 16px; border: 0; font-size: var(--fs-micro); line-height: 1; }'), []);
  // a size that does not follow the Chat setting keeps its box: a glyph sized to its own box
  assert.deepEqual(at('.a { height: 18px; font-size: 8px; }'), []);
  // a decorative box sizes no type of its own
  assert.deepEqual(at('.a { height: 1px; background: red; }'), []);
  // a size set for the same element by another rule is the one the box has to hold
  assert.deepEqual(at('.wrap .a { height: 22px; line-height: 1.5; }\n.a { font-size: var(--fs-small); }').length, 1);
  // a leading set by a sibling selector that shares only the tag belongs to another element: reading it
  // cleared `.segmented button` against `.selection-toolbar-bar button`'s 1.385, which does fit 24px
  assert.deepEqual(at('.seg button { height: 24px; padding: 0 8px; font-size: var(--fs-ui); }\n.bar button { line-height: 1.385; }'), [
    '.seg button: height 24px holds 25.08px at Chat 18 (font-size var(--fs-ui), line-height 1.5)',
  ]);
  // an ancestor-compatible rule for the same element is still read: the bare tag reaches it
  assert.deepEqual(at('.seg button { height: 24px; padding: 0 8px; font-size: var(--fs-ui); }\nbutton { line-height: 1.385; }'), []);
  // a ::before box is read on its own, falling back to the inherited default: the stricter of the two
  assert.deepEqual(at('.a::before { height: 24px; font-size: var(--fs-ui); }\n.a { line-height: 1.385; }').length, 1);
  // a leading that holds only while an at-rule does cannot clear a box that overflows without it
  assert.deepEqual(
    at('.a { height: 24px; padding: 0 8px; font-size: var(--fs-ui); }\n@media (max-width: 600px) { .a { line-height: 1.2; } }').length,
    1,
  );
  // inside the same at-rule it does apply, so the box it fits is held
  assert.deepEqual(
    at('@media (max-width: 600px) { .a { height: 24px; padding: 0 8px; font-size: var(--fs-ui); }\n.a { line-height: 1.2; } }'),
    [],
  );
  // a box this cannot measure is left alone rather than guessed at
  assert.deepEqual(at('.a { height: 22px; padding: 2% 0; font-size: var(--fs-small); }'), []);
  assert.deepEqual(at('.a { height: 22px; font-size: var(--fs-small); line-height: 1.5em; }'), []);
});

test('no shared min-height clamps a narrower rule that pins a smaller height', () => {
  assert.deepEqual(boxesClampedByASharedFloor(ALL_SHEETS), []);
  const at = (css: string) => boxesClampedByASharedFloor([['x.css', css]]).length;
  assert.equal(at('.pill { min-height: 28px; }\n.row .pill { height: 26px; }'), 1);
  assert.equal(at('.pill { min-height: 28px; }\n.row .pill { min-height: 26px; }'), 0);
  // a narrower rule raising the shared box is the intended direction
  assert.equal(at('.input { height: 32px; }\n.tall .input { min-height: 64px; }'), 0);
  // a bigger height than the floor is not clamped
  assert.equal(at('.pill { min-height: 28px; }\n.row .pill { height: 30px; }'), 0);
  // a pseudo-element is its own box, which its originating element's floor never clamps
  assert.equal(at('.row { min-height: 22px; }\n.row::after { height: 0.5px; }'), 0);
  // two rules that share a tag but not an ancestor reach different elements
  assert.equal(at('.a textarea { min-height: 44px; }\n.b textarea { height: 36px; }'), 0);
  // a pseudo-class narrows the same box, so the floor still reaches it
  assert.equal(at('.pill { min-height: 28px; }\n.row .pill:hover { height: 26px; }'), 1);
  // the same rule asking for both is a contradiction of its own
  assert.equal(at('.pill { min-height: 28px; height: 20px; }'), 1);
});

test('every looping animation can be turned off by the reduced-motion setting', () => {
  assert.deepEqual(
    loopsWithNoMotionOptOut(ALL_SHEETS),
    [],
    'an animation that repeats for ever needs a prefers-reduced-motion opt-out: declare it inside a ' +
      '`no-preference` block, or set `animation: none` for the same selector in a `reduce` one',
  );
});

test('the reduced-motion guard reads the media query around each rule, not only the declaration', () => {
  const at = (css: string) => loopsWithNoMotionOptOut([['x.css', css]]).map((m) => m.replace('x.css ', ''));
  assert.deepEqual(at('.a { animation: pulse 1s infinite; }'), ['.a: animation: pulse 1s infinite']);
  // the two ways to answer the setting: declared only without it, or switched off with it
  assert.deepEqual(at('.a { animation: pulse 1s infinite; }\n@media (prefers-reduced-motion: reduce) { .a { animation: none; } }'), []);
  assert.deepEqual(at('@media (prefers-reduced-motion: no-preference) { .a { animation: pulse 1s infinite; } }'), []);
  // the opt-out has to reach the same selector, and has to turn the animation off
  assert.deepEqual(
    at('.a { animation: pulse 1s infinite; }\n@media (prefers-reduced-motion: reduce) { .b { animation: none; } }').length,
    1,
  );
  assert.deepEqual(at('.a { animation: pulse 1s infinite; }\n@media (prefers-reduced-motion: reduce) { .a { opacity: 1; } }').length, 1);
  // a selector list is covered only once every selector in it is
  assert.deepEqual(
    at('.a, .b { animation: p 1s infinite; }\n@media (prefers-reduced-motion: reduce) { .a { animation: none; } }').length,
    1,
  );
  // a one-shot animation plays once and stops: it is not what the setting is for
  assert.deepEqual(at('.a { animation: fade-in 250ms ease; }'), []);
  // animation-name on its own, with the count elsewhere in the block
  assert.deepEqual(at('.a { animation-name: pulse; animation-iteration-count: infinite; }'), ['.a: animation-name: pulse']);
  assert.deepEqual(
    at(
      '.a { animation-name: pulse; animation-iteration-count: infinite; }\n@media (prefers-reduced-motion: reduce) { .a { animation: none; } }',
    ),
    [],
  );
});

test('MoMo’s Chat bounds its chat: it fills the page as a flex column that never outgrows it, so the transcript’s own scroller scrolls (#2277)', () => {
  // MomoPage renders Chat on its own, outside the scrolling .page the other views use (tests/momoPageUI.test.ts)
  const decls = (selector: string) => {
    const found: Record<string, string> = {};
    const css = readFileSync(new URL('../src/components/momo/momoChat.module.css', import.meta.url), 'utf8');
    postcss.parse(css).walkRules((rule) => {
      if (rule.selectors.includes(selector)) rule.walkDecls((decl) => void (found[decl.prop] = decl.value));
    });
    return found;
  };
  const chat = decls('.chat');
  assert.equal(chat.display, 'flex');
  assert.equal(chat['flex-direction'], 'column');
  assert.equal(chat.flex, '1');
  assert.equal(chat['min-height'], '0', 'a flex item’s automatic minimum would let the chat outgrow the page');
  assert.equal(chat.overflow, undefined, 'the chat itself never scrolls');
});

test('MoMo’s Chat restyles the shared composer and thread only inside its own .chat, so a coding chat keeps its composer', () => {
  const css = readFileSync(new URL('../src/components/momo/momoChat.module.css', import.meta.url), 'utf8');
  const loose: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    for (const selector of rule.selectors) if (selector.includes(':global(') && !selector.startsWith('.chat ')) loose.push(selector);
  });
  assert.deepEqual(loose, [], 'a global class restyled outside .chat would reach every chat');
});

test('MoMo’s Chat keeps dictation’s note inside its composer: its footer is no box for the note to sit above', () => {
  const css = readFileSync(new URL('../src/components/momo/momoChat.module.css', import.meta.url), 'utf8');
  const found: Record<string, Record<string, string>> = {};
  postcss.parse(css).walkRules((rule) => {
    for (const selector of rule.selectors) rule.walkDecls((decl) => void ((found[selector] ??= {})[decl.prop] = decl.value));
  });
  const note = found['.chat :global(.composer-right) > :global(.dictation-note)'];
  assert.equal(note.position, 'static', 'the shared composer places the note above its footer, which here is display: contents');
  assert.equal(note.flex, '0 0 100%', 'the note owns a row of the controls');
  assert.equal(found['.chat :global(.composer-right):has(:global(.dictation-note))']['flex-wrap'], 'wrap');
});
