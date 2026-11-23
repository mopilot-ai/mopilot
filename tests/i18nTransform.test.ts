// The interface text transform (scripts/i18n/transform.mjs): English renders exactly as written, a catalog reaches only
// literals from the source, and what isn't interface text is left alone.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { renderToStaticMarkup } from 'react-dom/server';
import { window } from './support/dom.ts';
import { __t, __tj, installLanguage } from '../src/lib/i18n.ts';
import { isInterfaceText, isProse, jsxText, objectTextIn, OPT_OUT, wrapInterfaceText } from '../scripts/i18n/transform.mjs';

const require = createRequire(import.meta.url);
const COMPONENT = 'src/components/fixture.tsx';

/** A fixture module's exports, compiled as the app compiles it, with the lookups as `__runtime`. */
function load(code: string) {
  const { code: out } = transformSync(code, { loader: 'tsx', format: 'cjs', jsx: 'automatic' });
  const module = { exports: {} as any };
  const need = (name: string) => (name === '__runtime' ? { __t, __tj } : require(name));
  new Function('require', 'module', 'exports', out)(need, module, module.exports);
  return module.exports;
}
const wrap = (code: string, file = COMPONENT) => wrapInterfaceText(code, file, { runtime: '__runtime' });
const render = (code: string, props = {}) => renderToStaticMarkup(load(code).View(props));
const speak = (messages: Record<string, string>) => installLanguage({ tag: 'test', messages });

beforeEach(() => speak({}));

const TRICKY = `
const NAMES = { open: 'Open', closed: 'Closed' };
export function View({ n = 3, name = 'plan.md', on = true }) {
  const label = on ? 'Turn it off' : 'Turn it on';
  return (
    <div title="It&apos;s &amp; more" aria-label={on ? 'Enabled' : 'Disabled'}>
      Found {n} files in <b>{name}</b>, sorted
      by name
      {/* a comment */}
      <p>  leading and trailing  </p>
      <p>first{' '}second</p>
      <p>a&nbsp;b</p>
      <>
        Fragment text
        <i>inner</i>
      </>
      <button title={\`Delete \${name}\`}>{on ? 'Stop' : 'Start'}</button>
      <select>
        <option>{n} items</option>
      </select>
      <span>{label}</span>
      <span>{NAMES.open}</span>
      <code>npm install</code>
      {[1, 2].map((i) => (
        <em key={i}>Row {i}</em>
      ))}
    </div>
  );
}`;

test('in English a wrapped file renders byte for byte what the source renders', () => {
  const { code } = wrap(TRICKY);
  assert.notEqual(code, TRICKY, 'something was wrapped');
  for (const props of [{}, { on: false, n: 0, name: 'a & b' }]) assert.equal(render(code, props), render(TRICKY, props));
});

test('spaces and entities at a sentence’s ends survive, and stay out of its message', () => {
  const cases: [string, string][] = [
    ['<p><i />&nbsp;Built in</p>', 'Built in'],
    ['<p>Hello&nbsp;<b>you</b></p>', 'Hello'],
    ["<p>{'Total: '}<b>7</b></p>", 'Total:'],
    ["<p><b>7</b>{' of the total'}</p>", 'of the total'],
    ['<p>Save &mdash; now &#38; here &#x41;</p>', 'Save — now & here A'],
    ['<p>Start here <b>now</b> and finish &nbsp;</p>', 'Start here {0} and finish'],
  ];
  for (const [jsx, message] of cases) {
    const source = `export const View = () => ${jsx};`;
    const { code, messages } = wrap(source);
    assert.ok(messages.includes(message), jsx);
    assert.equal(render(code), render(source), jsx);
  }
});

test('text with an entity this can’t decode, or a spread child, stays as written, and what sits beside it is still read', () => {
  assert.deepEqual(wrap('export const V = () => <p title="Mine &unknown; here">Foo &unknown; bar</p>;').messages, []);
  assert.deepEqual(wrap('export const V = (x) => <p>Found {...x} files <b title="Inner tip">Inner text</b></p>;').messages.sort(), [
    'Inner text',
    'Inner tip',
  ]);
});

test('a sentence around values and elements is one message, in the order the translation puts them', () => {
  const source = 'export const View = ({ n, name }) => <p>Found {n} files in <b>{name}</b>, sorted</p>;';
  const { code, messages } = wrap(source);
  assert.deepEqual(messages, ['Found {0} files in {1}, sorted']);
  speak({ 'Found {0} files in {1}, sorted': '在 {1} 中找到 {0} 个文件' });
  assert.equal(render(code, { n: 2, name: 'src' }), '<p>在 <b>src</b> 中找到 2 个文件</p>');
});

test('props, branches, templates, calls and object labels all reach the catalog', () => {
  const source = `
    const toast = (text) => text;
    const OPTIONS = [{ value: 'a', label: 'First choice' }];
    export const View = ({ on, name }) => (
      <a title={on ? 'On' : 'Off'} aria-label={\`Open \${name}\`} data-text={toast('Saved it')}>
        {OPTIONS[0].label}
      </a>
    );`;
  const { code, messages } = wrap(source);
  assert.deepEqual([...messages].sort(), ['First choice', 'Off', 'On', 'Open {0}', 'Saved it']);
  speak({ 'First choice': '第一项', On: '开', 'Open {0}': '打开 {0}', 'Saved it': '已保存' });
  assert.equal(render(code, { on: true, name: 'x' }), '<a title="开" aria-label="打开 x" data-text="已保存">第一项</a>');
});

test("a value the app holds is never translated, even one that equals a message: a chat called 'Settings' stays that", () => {
  const source = `export const View = ({ title, label }) => <div title={title}><span>{title}</span><b label={label}>{label}</b><i>Settings</i></div>;`;
  const { code } = wrap(source);
  speak({ Settings: '设置' });
  assert.equal(
    render(code, { title: 'Settings', label: 'Settings' }),
    '<div title="Settings"><span>Settings</span><b label="Settings">Settings</b><i>设置</i></div>',
  );
});

test('agent-bound and diagnostic text stays as written', () => {
  const source = `
    const noteIgnored = (text) => text;
    const prompt = 'Summarize the open pull requests';
    const reviewCommand = 'Review my latest changes';
    export const SEED = { prompt: 'Check the build status', command: 'Run the tests', url: 'Open the docs' };
    noteIgnored('save this window layout');
    export const View = () => <code>Do not touch</code>;`;
  assert.deepEqual(wrap(source), { code: source, messages: [] });
  const built = `export function loopPrompt(on) { return on ? 'Remind me about this' : 'Add this to my calendar'; }`;
  assert.deepEqual(wrap(built).messages, []);
  assert.deepEqual(wrap(`export default function () { return 'Nothing to show'; }`).messages, ['Nothing to show']);
  assert.deepEqual(wrap('export function CommandMenu() { return <b>Run something</b>; }').messages, ['Run something']);
});

test('a name that says not for people covers its own literals, and interface text deeper in it is still read', () => {
  const groups = wrap(
    `const GROUPS = [{ id: 'a', title: 'Needs you' }];\nexport const LIST = ['Built-in tools'];\nconst GROUP_IDS = ['Built-in tools', 'App'];`,
  );
  assert.deepEqual([...groups.messages].sort(), ['Built-in tools', 'Needs you']);
  const toasts = wrap(
    `const toast = (t) => t;\nexport const runCommand = (a) => { if (a) return 'Not for a person'; toast('Find is unavailable'); };`,
  );
  assert.deepEqual(toasts.messages, ['Find is unavailable']);
  const joined = wrap("export const briefPrompt = (t) => [\`Write the brief for \${t}\`, 'Include the background here'].join('\\n');");
  assert.deepEqual(joined.messages, []);
  const branches = wrap("export const quotePrompt = (a, b) => a ? 'Use the first one' : (b || \`Use the \${b} one\`) as string;");
  assert.deepEqual(branches.messages, []);
  assert.deepEqual(wrap(`export const LEGACY = { denied: { rejection: 'The user declined this request.' } };`).messages, []);
  assert.deepEqual(wrap(`export function loopPrompt(on) { if (on) { return 'Remind me'; } else return 'Add this now'; }`).messages, []);
});

test('a prompt function keeps every literal it builds, in any statement, and still reads the toasts it raises', () => {
  const source = `
    const toast = (t) => t;
    export function retryPrompt(c, list) {
      const intro = 'Continue, please, from here';
      for (const x of list) list.push(c ? 'Also check this' : 'Then stop there');
      switch (c) { case 1: return \`Try again with \${c}\`; }
      try { toast('Saved the draft'); } catch { return 'Something went wrong'; }
      return intro;
    }`;
  assert.deepEqual(wrap(source).messages, ['Saved the draft']);
});

test('a narration line whose words follow a fallback, or show only with a name, is still read', () => {
  const source =
    'export const step = (named, what) => ({ done: named ?? `Ran ${what}`, doing: (named || `Running ${what}`) as string, failed: named && `Failed ${what}` });';
  assert.deepEqual([...wrap(source).messages].sort(), ['Failed {0}', 'Ran {0}', 'Running {0}']);
});

test('a word key holds a word when it is capitalized, and a state id when it is not', () => {
  const source = `export const DOT = { needsInput: 'warn', failed: 'danger', done: 'done' };\nexport const WORD = (a) => ({ failed: 'Failed', done: a ? 'Done in' : 'done', doing: \`Reading \${a}\` });`;
  assert.deepEqual([...wrap(source).messages].sort(), ['Done in', 'Failed', 'Reading {0}']);
});

test('one word is interface text only where its position says so; a phrase also by its shape', () => {
  const source = `
    export const tool = 'Read';
    export const picked = (on) => (on ? 'Edit' : 'Write');
    export const said = (on) => (on ? 'Reading the file' : 'Read the file');
    export const rows = ['Summarizing the conversation', 'Input'];
    export const done = () => 'All finished here';
    export function total() { return 'Nothing to show'; }
    export const entry = { other: 'Something else entirely' };
    export const fallback = (name) => name || 'Nothing here yet';`;
  assert.deepEqual([...wrap(source).messages].sort(), [
    'All finished here',
    'Nothing here yet',
    'Nothing to show',
    'Read the file',
    'Reading the file',
    'Something else entirely',
    'Summarizing the conversation',
  ]);
});

test('a name that merely ends like an id is still interface text', () => {
  assert.deepEqual(wrap(`export const paid = 'Paid plan active'; export const userId = 'Some real id';`).messages, ['Paid plan active']);
});

test('every string in a search list is interface text, one word too, except what isn’t words', () => {
  const source = `export const KEYWORDS = { general: ['Language', 'Follow-up behavior: Queue', 'AGENTS.md'] };`;
  assert.deepEqual(wrap(source, 'src/lib/settingsSearch.ts').messages, ['Language', 'Follow-up behavior: Queue']);
  assert.deepEqual(wrap(source, 'src/lib/format.ts').messages, []);
});

test('objects outside the interface keep their strings: stores hold ids and saved data', () => {
  const source = `export const tab = { title: 'New chat', label: 'Saved label' };`;
  assert.deepEqual(wrap(source, 'src/store/panes.ts'), { code: source, messages: [] });
  assert.deepEqual(wrap(source, COMPONENT).messages, ['New chat', 'Saved label']);
  for (const file of ['src/components/a.tsx', 'src/harness/copy.ts', 'src/lib/agentNarration/tools.ts', 'src/lib/settingsNav.ts'])
    assert.equal(objectTextIn(file), true, file);
  assert.equal(objectTextIn('src/lib/format.ts'), false);
});

test('a narration line says both tenses, and a default in a pattern is read too', () => {
  const { messages } = wrap(`
    const line = (a, b) => [a, b];
    export const step = line('Reading artifact', 'Read artifact');
    export function Row({ label = 'Untitled' }) { return label; }
  `);
  assert.deepEqual([...messages].sort(), ['Read artifact', 'Reading artifact', 'Untitled']);
});

test('text a developer wrapped by hand is collected as it stands, and copied text is announced', () => {
  const { messages, code } = wrap(`
    const t = (text) => text;
    const copyText = (a, b) => [a, b];
    export const a = t('Harnesses');
    export const b = copyText(body, 'Copied the report');`);
  assert.deepEqual([...messages].sort(), ['Copied the report', 'Harnesses']);
  assert.match(code, /= t\('Harnesses'\)/);
});

test('a layout with many holes keeps its pieces apart', () => {
  const { messages } = wrap('export const V = () => <div>Before {1}{2}{3}{4}{5}{6}{7} after</div>;');
  assert.deepEqual(messages, ['Before', 'after']);
});

test('the opt-out, a file with no text and a file that does not parse come back unchanged', () => {
  for (const source of [`// ${OPT_OUT}\nexport const V = () => <b>Hello there</b>;`, 'export const a = 1;', 'export const = ;'])
    assert.deepEqual(wrap(source), { code: source, messages: [] });
});

test('a TypeScript and a JavaScript file parse in their own language, types untouched', () => {
  const ts = wrap(
    `interface P { label: 'Literal type' }\nexport const a = { label: 'Shown label' } as const satisfies P;`,
    'src/components/a.ts',
  );
  assert.deepEqual(ts.messages, ['Shown label']);
  assert.deepEqual(wrap(`toast('Saved it');`, 'src/a.js').messages, ['Saved it']);
});

test('namespaced and member tags and quoted keys are read like any other', () => {
  const source = `
    export const V = () => <a.b xlink:title="Not a text prop">Member tag text</a.b>;
    export const row = { 'label': 'Quoted key label', [dynamic]: 'Computed entry here' };`;
  assert.deepEqual(wrap(source).messages.sort(), ['Member tag text', 'Quoted key label']);
});

test('an element that only holds text keeps a sentence with holes as one string', () => {
  const { code, messages } = wrap('export const View = ({ n }) => <select><option>Show {n} items</option></select>;');
  assert.deepEqual(messages, ['Show {0} items']);
  speak({ 'Show {0} items': '显示 {0} 项' });
  assert.equal(render(code, { n: 3 }), '<select><option>显示 3 项</option></select>');
});

test('the import goes last, so no line of the file moves', () => {
  const { code } = wrap('export const V = () => <b>Hello there</b>;\nexport const line2 = 2;');
  assert.equal(code.split('\n')[1], 'export const line2 = 2;');
  assert.ok(code.trimEnd().endsWith('import { __t, __tj } from "__runtime";'));
  assert.equal(wrapInterfaceText('toast("Saved it")', 'src/a.ts').code, '__t("Saved it")'.replace(/^/, 'toast(') + ')');
});

test('what counts as interface text', () => {
  for (const text of ['Save', 'open', 'Couldn’t save the file', 'chats', '今日は']) assert.equal(isInterfaceText(text), true, text);
  for (const text of [
    '',
    'x',
    '42',
    'https://mopilot.ai',
    '/usr/bin',
    '.env',
    '--flag',
    '{0}',
    'fooBar',
    'a_b',
    'src/a.ts',
    'key=value',
    'npm install',
    'claude auth login',
    'sk-ant-…',
  ])
    assert.equal(isInterfaceText(text), false, text);
  assert.equal(isProse('Reading the file'), true);
  assert.equal(isProse('Read'), false);
  assert.equal(isProse('lowercase words here'), false);
  assert.equal(isProse('Enter'), false);
});

test('JSX text keeps what JSX keeps', () => {
  assert.equal(jsxText('  same line  '), '  same line  ');
  assert.equal(jsxText('\n    two\n    lines\n  '), 'two lines');
  assert.equal(jsxText('\n   \n'), '');
  assert.equal(jsxText('a\tb'), 'a b');
  assert.equal(jsxText('\r\n  x '), 'x ');
});

test('the DOM stand-in is the one the app tests use', () => assert.ok(window.document));
