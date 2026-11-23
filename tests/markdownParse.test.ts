// The one parser the phone's Markdown renderer and its prose helper read through (shared/markdownParse.mjs): tables, strikethrough and emphasis next to CJK punctuation, as the Mac reads them (#4644).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../shared/markdownParse.mjs';
import { mapProse, maskMarkdownCode } from '../shared/markdownProse.mjs';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const kinds = (md: string) => parseMarkdown(md).children.map((c) => c.type);

test('a table straight after a paragraph line is a table; `**` after full-width punctuation is strong', () => {
  assert.deepEqual(kinds('三个办法：\n| a | b |\n|---|---|\n| 1 | 2 |'), ['paragraph', 'table']);
  const [paragraph] = parseMarkdown('。**加粗。**清单').children as { children: { type: string }[] }[];
  assert.deepEqual(
    paragraph!.children.map((c) => c.type),
    ['text', 'strong', 'text'],
  );
  assert.deepEqual(kinds('~~旧~~的'), ['paragraph']);
  assert.equal((parseMarkdown('~~旧航班(停飞)~~的').children[0] as { children: { type: string }[] }).children[0]!.type, 'delete');
});

test('code inside a table cell is code for the prose helper, so its text is left alone', () => {
  assert.equal(maskMarkdownCode('| a |\n|---|\n| `x` |').includes('x'), false);
});

type Node = {
  type: string;
  url?: string;
  value?: string;
  children?: Node[];
  position: { start: { offset: number }; end: { offset: number } };
};
const firstParagraph = (md: string) => (parseMarkdown(md).children[0] as unknown as Node).children!;
const links = (md: string) => firstParagraph(md).filter((n) => n.type === 'link');
const span = (n: Node) => [n.position.start.offset, n.position.end.offset];

test('a bare URL, a www address and an email are links, each with its place in the source (#5116)', () => {
  const md = 'See https://example.com/a?b=1. Also www.example.org and me@example.com, `https://code.example` stays code';
  const found = links(md);
  assert.deepEqual(
    found.map((n) => n.url),
    ['https://example.com/a?b=1', 'http://www.example.org', 'mailto:me@example.com'],
  );
  for (const link of found) {
    assert.equal(md.slice(...span(link)), link.children![0]!.value, 'the link is its own source text');
    assert.deepEqual(span(link.children![0]!), span(link), 'and so is the text inside it, with offsets the fade reads');
  }
  assert.equal(firstParagraph(md).filter((n) => n.type === 'inlineCode').length, 1);
});

test('a bare URL stops before a full-width comma, full stop or quote, and the rest stays text at its own offsets (#5116)', () => {
  const md = '详见https://example.com/x，请看。见 https://b.example/页面。谢谢';
  const nodes = firstParagraph(md);
  assert.deepEqual(
    nodes.filter((n) => n.type === 'link').map((n) => n.url),
    ['https://example.com/x', 'https://b.example/页面'],
  );
  for (const n of nodes) {
    assert.equal(md.slice(...span(n)), n.type === 'link' ? n.children![0]!.value : n.value, `${n.type} keeps its source slice`);
  }
  assert.equal(nodes.map((n) => (n.type === 'link' ? n.children![0]!.value : n.value)).join(''), md, 'nothing is lost or repeated');
});

test('an explicit link, an angle-bracket link and a link written twice keep their own text; a link is not made inside a link (#5116)', () => {
  const found = links('[docs](https://docs.example) <https://auto.example> [https://x.example](https://y.example)');
  assert.deepEqual(
    found.map((n) => n.url),
    ['https://docs.example', 'https://auto.example', 'https://y.example'],
  );
  assert.equal(found[0]!.children![0]!.value, 'docs');
});

test('the phone reads the same links as the Mac renderer (remark-gfm) over every form an agent writes one in (#5116)', () => {
  const corpus = [
    'Open https://example.com/a?b=1&c=2#frag now.',
    'Trailing dot https://example.com/path. Next sentence, and (see https://example.com/x_(y)) too',
    'www.example.org/docs and mail me@example.com',
    '[docs](https://docs.example/a) and <https://auto.example/b> and https://bare.example/c',
    '- https://list.example/a\n- [b](https://list.example/b)\n\n> https://quote.example/q',
    '| a | b |\n|---|---|\n| https://cell.example/x | [t](https://cell.example/y) |',
    '**https://strong.example/s** and *https://em.example/e* and ~~https://gone.example~~',
    '`https://code.example` and ```\nhttps://fenced.example\n```',
  ];
  const urls = (tree: Node, out: string[] = []): string[] => {
    if (tree.type === 'link') out.push(tree.url!);
    for (const child of tree.children ?? []) urls(child, out);
    return out;
  };
  const mac = unified().use(remarkParse).use(remarkGfm);
  for (const md of corpus) {
    assert.deepEqual(urls(parseMarkdown(md) as unknown as Node), urls(mac.parse(md) as unknown as Node), md);
  }
});

// A backtick inside a bare address belongs to the address (the Mac renders it so already, through remark-gfm); the rewrite now agrees with the drawing.
test('the Mac reads code ranges through this parser (math rewriting): a bare URL is prose, and the code around it keeps its ranges (#5116)', () => {
  const md = 'see https://a.example/x_(y)_z?p=$1 and `c` then www.b.example/`d`';
  assert.equal(
    mapProse(
      md,
      (prose) => `<${prose}>`,
      (code) => `[${code}]`,
    ),
    '<see https://a.example/x_(y)_z?p=$1 and >[`c`]< then www.b.example/`d`>',
  );
  assert.equal(
    maskMarkdownCode('https://a.example/x\n\n```\nhttps://hidden.example\n```'),
    `https://a.example/x\n\n   \n${' '.repeat('https://hidden.example'.length)}\n   `,
  );
});

test('what follows a cut address is read as Markdown again: emphasis, code, a written link and a second address all keep their meaning (#5116)', () => {
  const kinds = (md: string) => firstParagraph(md).map((n) => (n.type === 'link' ? `link ${n.url}` : n.type));
  assert.deepEqual(kinds('详见https://a.com，**重点**说明'), ['text', 'link https://a.com', 'text', 'strong', 'text']);
  assert.deepEqual(kinds('详见https://a.com，更多[文档](https://b.com)说明'), [
    'text',
    'link https://a.com',
    'text',
    'link https://b.com',
    'text',
  ]);
  assert.deepEqual(kinds('网址：https://a.com，邮箱：me@b.com，详情 www.c.com。'), [
    'text',
    'link https://a.com',
    'text',
    'link mailto:me@b.com',
    'text',
    'link http://www.c.com',
    'text',
  ]);
  assert.deepEqual(kinds('https://a.com，`code`'), ['link https://a.com', 'text', 'inlineCode']);
});

test('a cut address and its tail are laid out over the source exactly: every text and link slice is its own value (#5116)', () => {
  const corpus = [
    '详见https://a.com，**重点**说明和 https://b.com/x。再见',
    '第一行 https://a.com，好\n第二行 www.b.com/路径，**粗**',
    '| 链接 |\n|---|\n| https://a.com，说明 |',
    '- 看https://a.com/x，*细节*\n- 另一个https://b.com看看',
  ];
  const check = (md: string, node: Node) => {
    if (node.type === 'text') assert.equal(md.slice(...span(node)), node.value, `${md}: text ${node.value}`);
    if (node.type === 'link' && node.children!.length === 1 && node.children![0]!.position.start.offset === node.position.start.offset)
      assert.equal(md.slice(...span(node)), node.children![0]!.value, `${md}: link ${node.url}`);
    for (const child of node.children ?? []) check(md, child);
  };
  for (const md of corpus) check(md, parseMarkdown(md) as unknown as Node);
});

test('an address stops where the sentence begins, not inside a name: a Japanese or numeric path is whole, a word glued to the host is not part of it (#5116)', () => {
  assert.deepEqual(
    links('https://ja.wikipedia.org/wiki/佐々木 and https://a.com/二〇二四 and https://zh.wikipedia.org/wiki/北京').map((n) => n.url),
    ['https://ja.wikipedia.org/wiki/佐々木', 'https://a.com/二〇二四', 'https://zh.wikipedia.org/wiki/北京'],
  );
  assert.deepEqual(
    links('访问https://a.com看看，联系me@a.com你好').map((n) => n.url),
    ['https://a.com', 'mailto:me@a.com'],
  );
});

test('an address cut on a line of a quote or list whose later lines carry the markers is kept whole, its tail as the words it is (#5116)', () => {
  const md = '> 看https://a.com，**x**\n> 第二行 https://b.com/y\n\n- 条目https://c.com，说明\n  续行';
  const tree = parseMarkdown(md) as unknown as Node;
  const urls: string[] = [];
  const walk = (node: Node) => {
    if (node.type === 'link') urls.push(node.url!);
    if (node.type === 'text') assert.equal(typeof node.position.start.offset, 'number');
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  assert.ok(urls.includes('https://a.com') && urls.includes('https://c.com'), urls.join());
});
