// A reply's tables and CJK emphasis on the phone's classic renderer (#4644): a table straight after a paragraph line is a table, `**…**` next to full-width punctuation is bold, and what the Mac's renderer shows, the phone shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const markdownPath = '../mobile/src/components/Markdown';
const { Markdown } = await import(markdownPath);

// the owner's reply, word for word (#4644)
const REPLY = `正面宽 21.5″ 对上 LMC1575 (21.41″)。**LG 官方的 30″ 嵌入框 MK2030NST 只配 2.0 立方英尺的 LMC2075，这台没有配套的嵌入框。**清单里的微波炉卡片改成了三个办法：
| 办法 | 花费 | 说明 |
|---|---|---|
| **推荐**：换 LG LMC2075ST + MK2030NST 嵌入框 | 约 $259 + $259 ≈ **$520** | 外观和现在这台一样，官方配套。 |
| Bosch 500 HMB50152UC（原生嵌入式） | **$999** | 不用嵌入框，最整齐 |`;

async function draw(text: string, props: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Markdown, { text, ...props })));
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const style = (el: Element | null | undefined) => JSON.parse(el?.getAttribute('data-style') ?? '{}');
const spans = (host: HTMLElement, text: string) => [...host.querySelectorAll('span')].filter((n) => n.textContent === text);
/** The cells of every table, row by row: a table is a grid whose children are rows and whose rows' children are cells. */
const cells = (host: HTMLElement) =>
  [...host.querySelectorAll('[role="grid"]')].flatMap((grid) => [...grid.children].flatMap((row) => [...row.children]));

test('the owner’s reply: the table is a table and both bold runs are bold, with no markup left in the text', async () => {
  const v = await draw(REPLY);
  const text = v.host.textContent!;
  assert.ok(!text.includes('|---|'), 'the delimiter row is not shown');
  assert.ok(!text.includes('**'), 'no asterisks are shown');
  assert.ok(!text.includes('| 办法'), 'no pipes are shown');
  assert.deepEqual(
    cells(v.host).map((c) => c.textContent),
    [
      '办法',
      '花费',
      '说明',
      '推荐：换 LG LMC2075ST + MK2030NST 嵌入框',
      '约 $259 + $259 ≈ $520',
      '外观和现在这台一样，官方配套。',
      'Bosch 500 HMB50152UC（原生嵌入式）',
      '$999',
      '不用嵌入框，最整齐',
    ],
  );
  assert.equal(
    style(spans(v.host, 'LG 官方的 30″ 嵌入框 MK2030NST 只配 2.0 立方英尺的 LMC2075，这台没有配套的嵌入框。').at(-1)).fontWeight,
    '600',
  );
  assert.equal(style(spans(v.host, '推荐').at(-1)).fontWeight, '600', 'bold inside a cell');
  assert.equal(style(spans(v.host, '$520').at(-1)).fontWeight, '600');
  await v.done();
});

test('a table is a header row then body rows, each cell aligned as its delimiter says, and VoiceOver reads the header cells as headers', async () => {
  const v = await draw('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |');
  const all = cells(v.host);
  assert.deepEqual(
    all.map((c) => style(c).textAlign ?? 'left'),
    ['left', 'center', 'right', 'left', 'center', 'right'],
  );
  assert.deepEqual(
    all.map((c) => c.getAttribute('role')),
    ['header', 'header', 'header', null, null, null],
  );
  assert.equal(style(all[0]).fontWeight, '600', 'the header row is heavier');
  await v.done();
});

test('a table interrupts a paragraph, sits in a list item, and keeps links and code in its cells', async () => {
  const v = await draw('before:\n| a | b |\n|---|---|\n| `x` | [l](https://example.com) |\n\n- item\n\n  | c |\n  |---|\n  | 9 |');
  assert.deepEqual(
    cells(v.host).map((c) => c.textContent),
    ['a', 'b', 'x', 'l', 'c', '9'],
  );
  assert.ok(v.host.querySelector('[role="link"]'), 'a link in a cell stays a link');
  assert.ok(!v.host.textContent!.includes('|'));
  await v.done();
});

test('a wide table scrolls sideways instead of squeezing its columns', async () => {
  const row = `| ${Array.from({ length: 8 }, (_, i) => `column ${i}`).join(' | ')} |`;
  const v = await draw(`${row}\n|${'---|'.repeat(8)}\n${row}`);
  assert.ok(v.host.querySelector('[role="grid"]')!.closest('[data-horizontal="true"]'), 'the table sits in a horizontal scroll');
  await v.done();
});

test('a table that is still arriving never shows its rows as source', async () => {
  // the header alone is held back by the reveal; once the delimiter is in, a half row is a row
  const half = '| 办法 | 花费 |\n|---|---|\n| 推荐 | 约 $2';
  const v = await draw(half, { streaming: true });
  assert.ok(!v.host.textContent!.includes('|'), v.host.textContent!);
  assert.deepEqual(
    cells(v.host).map((c) => c.textContent),
    ['办法', '花费', '推荐', '约 $2'],
  );
  await v.done();
});

test('emphasis, strong and strikethrough close next to CJK punctuation and letters, as on the Mac', async () => {
  const cases: [string, string, Record<string, string>][] = [
    ['**更便宜，但落地时间不对**。', '更便宜，但落地时间不对', { fontWeight: '600' }],
    ['选**「机票与交通」**那组', '「机票与交通」', { fontWeight: '600' }],
    ['**星宇(JX)**的代码', '星宇(JX)', { fontWeight: '600' }],
    ['这是*强调。*字', '强调。', { fontStyle: 'italic' }],
    ['这是 _强调。_ 字', '强调。', { fontStyle: 'italic' }],
    ['~~旧航班(停飞)~~的', '旧航班(停飞)', { textDecorationLine: 'line-through' }],
    ['**LG 嵌入框。**清单', 'LG 嵌入框。', { fontWeight: '600' }],
  ];
  for (const [md, inner, want] of cases) {
    const v = await draw(md);
    assert.ok(!/[*_~]/.test(v.host.textContent!), `${md} shows its marks: ${v.host.textContent}`);
    const hit = spans(v.host, inner).at(-1);
    for (const [key, value] of Object.entries(want)) assert.equal(style(hit)[key], value, md);
    await v.done();
  }
});

test('next to CJK punctuation a link, inline code and nested emphasis keep their own form', async () => {
  const v = await draw('见[文档](https://example.com/a)。然后`npm test`，**粗体里有*斜体*。**结束');
  assert.ok(v.host.querySelector('[role="link"]'));
  assert.equal(spans(v.host, 'npm test').length > 0, true);
  assert.ok(!/[*`\[\]]/.test(v.host.textContent!.replace(/[^*`\[\]]/g, '')), v.host.textContent!);
  assert.equal(style(spans(v.host, '斜体').at(-1)).fontStyle, 'italic');
  await v.done();
});

test('an underscore inside a word stays literal, as on the Mac (CJK-friendly changes `*` and `~~`, not `_`)', async () => {
  const v = await draw('这是_强调。_字');
  assert.equal(v.host.textContent, '这是_强调。_字');
  await v.done();
});

test('Latin text keeps the CommonMark rules: `**foo.**bar` and `2 * 3 * 4` are not emphasis', async () => {
  const a = await draw('**foo.**bar');
  assert.equal(a.host.textContent, '**foo.**bar');
  await a.done();
  const b = await draw('2 * 3 * 4');
  assert.equal(b.host.textContent, '2 * 3 * 4');
  await b.done();
});

test('a ragged table keeps its columns, and a very long cell stops at a column width', async () => {
  const long = '很长'.repeat(60);
  const v = await draw(`| a | b | c |\n|---|---|---|\n| ${long} |\n| 1 | 2 | 3 |`);
  const all = cells(v.host);
  assert.equal(all.length, 3 + 1 + 3, 'a short row has the cells it was written with');
  assert.equal(style(all[3]).width, 240, 'a long cell is as wide as a column goes');
  assert.equal(style(all[1]).width, 72, 'a short column is as narrow as one goes');
  await v.done();
});

test('the header row’s words are heavier than the cells’ words', async () => {
  const v = await draw('| 头 | 值 |\n|---|---|\n| 体 | 8 |');
  assert.equal(style(spans(v.host, '头').at(-1)).fontWeight, '600');
  assert.notEqual(style(spans(v.host, '体').at(-1)).fontWeight, '600');
  await v.done();
});

test('a reply with a table in a message bubble is read as its cells: no label holds the source, the header cells are headers, links stay reachable (#4644, #4259)', async () => {
  const bubblePath = '../mobile/src/components/MessageBubble';
  const { MessageBubble } = await import(String(bubblePath));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(MessageBubble, { role: 'assistant', text: REPLY + '\n\n见[文档](https://example.com)。' })),
  );
  const labels = [...host.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label')!);
  assert.deepEqual(
    labels.filter((l) => /\||\*\*|---/.test(l)),
    [],
    'no label holds pipes, asterisks or the delimiter row',
  );
  assert.deepEqual(
    [...host.querySelectorAll('[role="header"]')].map((el) => el.textContent),
    ['办法', '花费', '说明'],
  );
  assert.ok(host.querySelector('[role="link"]'), 'a link stays its own stop');
  await act(async () => root.unmount());
  host.remove();
});
