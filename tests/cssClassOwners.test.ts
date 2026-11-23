// One owner per global class name: the composer's PR sheet named its rows `.pr-row` and `.pr-row-title`, the Review
// page's PR list already had them in another stylesheet, and the later rule turned the sheet's rows into centered
// columns (and the sheet's rules centered the Review list). Every stylesheet in src/ is global, so a class whose base
// rule (`.name { … }` alone) is in two stylesheets must be one component styled in layers, listed here with why;
// a new pair of files defining the same name is a collision until someone names the reason. A component that owns its
// styles keeps them in a CSS Module next to it (`x.module.css`, its classes local to it), so only src/styles holds
// global stylesheets, and each module's classes are the ones its components use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['src/'];

/** Classes whose base rules are split across stylesheets on purpose, by why. */
const LAYERED: Record<string, string[]> = {
  'Settings: settings-metrics.css and settings-extended.css refine the base Settings rules to measured metrics': [
    'settings-page',
    'settings-inner',
    'settings-title',
    'settings-group',
    'settings-group-head',
    'settings-group-title',
    'settings-card',
    'settings-row',
    'settings-row-title',
    'settings-row-desc',
    'settings-row-control',
    'settings-path',
    'settings-links',
    'mode-thumbs',
    'mode-thumb',
    'config-warning',
    'connections-empty',
  ],
  'shared controls: settings-metrics.css retunes them to the official app measurements': [
    'mono',
    'select-btn',
    'btn-white',
    'tabs-seg',
    'menu',
  ],
  'motion.css adds each surface its transitions on top of the surface layout file': [
    'sidebar',
    'side-pane',
    'popover-layer',
    'modal',
    'modal-backdrop',
    'toast',
  ],
  "thread-metrics.css holds the measured metrics of the thread's own components": [
    'turn',
    'user-message',
    'user-bubble',
    'message-actions',
    'worked-for',
    'edited-card',
  ],
  'the agents page, the tasks pane and its status pill style the same task components': [
    'task-card',
    'task-event-card',
    'tasks-count',
    'tasks-caret',
  ],
  "scheduled-empty.css restyles the Scheduled page's empty state laid out in page-sidebars.css": [
    'sched-empty',
    'sched-empty-icon',
    'sched-empty-title',
    'sched-empty-sub',
    'sched-templates',
    'sched-template',
    'sched-template-emoji',
    'sched-template-text',
    'sched-template-name',
    'sched-template-desc',
  ],
  'the Skills and Plugins catalogs share one row layout': [
    'plugin-section',
    'plugin-section-title',
    'plugin-rows',
    'plugin-row',
    'plugin-row-text',
    'plugin-desc',
  ],
  'the browser pane and its full view share one toolbar': ['browser-addr', 'newtab'],
  'the add (+) panel: its menu rows and its card': ['add-panel', 'add-panel-label'],
  'Markdown blocks: markdown.css lays them out, thread-messages.css sizes them in a chat': ['code-block', 'md-table-wrap'],
  'the account meters show in the accounts menu and on the Usage page': ['limit-reset'],
  'the goal pill shares the changes pill layout': ['goal-pill'],
  'the billing key form shows on the harness and Usage pages': ['hs-key-form'],
  'command output: thread-steps.css lays it out, scroll-fade.css fades its edges': ['shell-scroll'],
};

const MODULE = /\.module\.css$/;
/** The global stylesheets: a CSS Module's classes are local to it, so they meet no other file's. */
const sheets = treeFiles('src', /\.css$/).filter((file) => !MODULE.test(file));
const modules = treeFiles('src', MODULE);

/** Class name → the stylesheets with a rule for it alone (`.name {`, or `.name` as one item of a selector list). */
function baseRules() {
  const owners = new Map<string, Set<string>>();
  for (const file of sheets) {
    const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectors] of css.matchAll(/([^{}]+)\{/g)) {
      for (const selector of selectors.split(',')) {
        const name = /^\.([\w-]+)$/.exec(selector.trim())?.[1];
        if (name) owners.set(name, (owners.get(name) ?? new Set()).add(file));
      }
    }
  }
  return owners;
}

const owners = baseRules();
const layered = new Set(Object.values(LAYERED).flat());

test('the stylesheets are found and parsed', () => {
  assert.ok(sheets.length > 20, `${sheets.length} stylesheets`);
  assert.ok(owners.get('review-pr-row')?.has('src/styles/app/page-sidebars.css'));
  assert.ok(modules.includes('src/components/thread/prMonitor.module.css'));
  assert.ok(!owners.has('prRow'), 'a CSS Module is not read as a global stylesheet');
});

test('a class has its base rule in one stylesheet, or is listed as one component styled in layers', () => {
  const shared = [...owners]
    .filter(([name, files]) => files.size > 1 && !layered.has(name))
    .map(([name, files]) => `.${name}: ${[...files].join(', ')}`);
  assert.deepEqual(shared, [], "rename one component's class, or list the class in LAYERED with why");
});

test('each listed class still has base rules in more than one stylesheet', () => {
  const single = [...layered].filter((name) => (owners.get(name)?.size ?? 0) < 2);
  assert.deepEqual(single, [], 'drop these from LAYERED');
});

test('a stylesheet outside src/styles is a CSS Module, owned by the components next to it', () => {
  const global = treeFiles('src', /\.css$/).filter((file) => !file.startsWith(`src${path.sep}styles${path.sep}`) && !MODULE.test(file));
  assert.deepEqual(global, [], 'rename it to <name>.module.css and import its classes as styles.<name>');
  assert.deepEqual(
    modules.filter((file) => file.startsWith(`src${path.sep}styles${path.sep}`)),
    [],
    'src/styles holds the global stylesheets',
  );
});

/** Removes every `:global(…)`, with what it names: the app's own classes are not the module's. */
function withoutGlobals(css: string) {
  let text = css;
  for (let at = text.indexOf(':global('); at >= 0; at = text.indexOf(':global(')) {
    let depth = 0;
    let end = at + ':global'.length;
    do depth += text[end] === '(' ? 1 : text[end] === ')' ? -1 : 0;
    while (depth > 0 && ++end < text.length);
    text = text.slice(0, at) + text.slice(end + 1);
  }
  return text;
}

/**
 * A module's rules: each selector of each rule with its global classes, attribute selectors and comments left out (so
 * `[href$='.pdf']` is no class), and the rule's body. The bare `:global .x` form is refused, so every global is in
 * parentheses.
 */
function moduleRules(css: string) {
  const text = withoutGlobals(css.replace(/\/\*[\s\S]*?\*\//g, '')).replace(/\[[^\]]*\]/g, '');
  assert.doesNotMatch(text, /:(?:global|local)\b/, 'name a global class as :global(.name)');
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors.split(',').map((s) => s.trim()),
    body,
  }));
}

/** A module's own classes: every `.name` in its selectors. */
function moduleClasses(css: string) {
  const names = new Set<string>();
  for (const { selectors } of moduleRules(css))
    for (const selector of selectors) for (const [, name] of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) names.add(name);
  return names;
}

const IMPORT = /^import (\w+) from '(\.[^']+\.module\.css)';$/gm;

/** Each module, by the classes the source files that import it read (`styles.name` or `styles['name']`). */
function moduleUses() {
  const uses = new Map(modules.map((file) => [file, new Set<string>()]));
  const unread: string[] = [];
  for (const file of treeFiles('src', /\.tsx?$/)) {
    const source = fs.readFileSync(file, 'utf8');
    // every import of a module in the one form this check reads: a default import, single quotes, a relative path
    const imports = [...source.matchAll(IMPORT)];
    const named = source.split('\n').filter((line) => /\.module\.css['"]/.test(line));
    if (named.length !== imports.length) unread.push(...named.map((line) => `${file}: ${line.trim()}`));
    // comments are not reads; a string that says the binding's name is one the check cannot tell apart, so it fails
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [statement, binding, spec] of imports) {
      const used = uses.get(path.join(path.dirname(file), spec));
      assert.ok(used, `${file}: ${spec} is not a CSS Module in src`);
      const rest = code.replace(statement, '');
      for (const [read, dot, key] of rest.matchAll(new RegExp(`\\b${binding}\\b(?:\\.(\\w+)|\\['([\\w-]+)'\\])?`, 'g'))) {
        if (dot ?? key) used.add(dot ?? key);
        else unread.push(`${file}: ${read}`);
      }
    }
  }
  return { uses, unread };
}

test("a CSS Module's classes are exactly the ones its components read, each by name", () => {
  const { uses, unread } = moduleUses();
  assert.deepEqual(
    unread,
    [],
    "import a module as `import styles from './x.module.css'` and read a class by its name (a state is a data attribute)",
  );
  for (const [file, used] of uses) {
    const defined = moduleClasses(fs.readFileSync(file, 'utf8'));
    assert.ok(used.size > 0, `${file}: no component imports it`);
    assert.deepEqual(
      [...used].filter((name) => !defined.has(name)),
      [],
      `${file}: read by a component but not in the stylesheet`,
    );
    assert.deepEqual(
      [...defined].filter((name) => !used.has(name)),
      [],
      `${file}: in the stylesheet but read by no component`,
    );
  }
});

/** The parts of class names that global rules match by substring (`[class*='-row']`), by the stylesheet they are in. */
function classSubstrings() {
  const found: [string, string][] = [];
  for (const file of sheets)
    for (const [, part] of fs.readFileSync(file, 'utf8').matchAll(/\[class[*^]=['"]([^'"]+)['"]\]/g)) found.push([part, file]);
  return found;
}
const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

test('a module class that a global substring rule would have matched under its old name states that rule itself', () => {
  // motion.css fades hover feedback on `[class*='-row']`; a hashed `_prRow_1x2y` never matches it (the PR sheet's
  // rows lost their fade when they became a module), so the module restates the transition for those classes
  const parts = classSubstrings();
  assert.ok(parts.some(([part, file]) => part === '-row' && file.endsWith('motion.css')));
  const missing: string[] = [];
  for (const file of modules) {
    const rules = moduleRules(fs.readFileSync(file, 'utf8'));
    const transitioned = new Set(
      rules.filter((r) => /(^|;)\s*transition\s*:/.test(r.body)).flatMap((r) => r.selectors.map((s) => /^\.([\w-]+)$/.exec(s)?.[1])),
    );
    for (const name of moduleClasses(fs.readFileSync(file, 'utf8')))
      for (const [part, sheet] of parts)
        if (kebab(name).includes(part) && !transitioned.has(name)) missing.push(`${file} .${name}: ${sheet} [class*='${part}']`);
  }
  assert.deepEqual(missing, [], 'give the class the transition the global rule gives its pattern');
});

test('the module reader leaves out the global classes and comments, and the unit tests read a module as its own names', async () => {
  const css = '/* .gone */ :global(.app:has(.a > .b)) > .sheet:not(:has(+ :global(.composer))) .row[href$=".pdf"] { margin: 0.5px }';
  assert.deepEqual([...moduleClasses(css)], ['sheet', 'row']);
  assert.throws(() => moduleClasses(':global .app .sheet {}'), /:global\(\.name\)/);
  assert.equal(kebab('prRowsMore'), 'pr-rows-more');
  // tests/support/register.ts: `styles.x` is the class as written, where Vite would hash it
  const { default: styles } = await import('../src/components/thread/prMonitor.module.css');
  assert.equal(styles.prRow, 'prRow');
  assert.equal((styles as Record<symbol, unknown>)[Symbol.toPrimitive], undefined);
});
