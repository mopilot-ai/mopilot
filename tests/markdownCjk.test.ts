// Bold and strikethrough next to CJK text, rendered with the app's remark plugins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { normalizeAutolinks, normalizeMath, remarkPlugins } from '../src/lib/markdownMath.ts';

const html = (md: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins }, md));

test('bold ending in punctuation closes before a CJK letter', () => {
  assert.match(html('**星宇(JX)**的代码'), /<strong>星宇\(JX\)<\/strong>的代码/);
  assert.match(html('选**「机票与交通」**那组'), /<strong>「机票与交通」<\/strong>那组/);
  assert.match(html('**更便宜，但落地时间不对**。'), /<strong>更便宜，但落地时间不对<\/strong>。/);
});

test('strikethrough ending in punctuation closes before a CJK letter', () => {
  assert.match(html('~~旧航班(停飞)~~的'), /<del>旧航班\(停飞\)<\/del>的/);
});

test('ordinary emphasis is unchanged', () => {
  assert.match(html('some **bold** text'), /some <strong>bold<\/strong> text/);
  assert.match(html('*italic* and ~~gone~~'), /<em>italic<\/em> and <del>gone<\/del>/);
  // CommonMark still leaves intraword `**` after punctuation in Latin text alone
  assert.doesNotMatch(html('**foo.**bar'), /<strong>/);
  assert.match(html('2 * 3 * 4'), /2 \* 3 \* 4/);
});

test('bold bare URL followed by CJK punctuation keeps the link and the bold', () => {
  const out = renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins }, normalizeMath('1. 打开 **https://developer.apple.com/account**，用付费账号登录（Team ID）')),
  );
  assert.match(
    out,
    /<strong><a href="https:\/\/developer\.apple\.com\/account">https:\/\/developer\.apple\.com\/account<\/a><\/strong>，用付费账号登录/,
  );
});

test('normalizeAutolinks leaves ordinary links, angle links, code and plain text alone', () => {
  for (const md of [
    'see https://a.com/x now',
    '[t](https://a.com/x)，好',
    '<https://a.com/x>，好',
    '`https://a.com/x`，好',
    'no links here',
  ])
    assert.equal(normalizeAutolinks(md), md);
  assert.equal(normalizeAutolinks('https://a.com你好'), '<https://a.com>你好');
});

// #4644: the reply the owner saw as source on the phone. The Mac's stack (remark-gfm, remark-cjk-friendly) draws it as a table and as bold; the phone's parsers must agree.
test('a table straight after a paragraph line and bold after full-width punctuation render, as on the phone must', () => {
  const reply = [
    '正面宽 21.5″ 对上 LMC1575 (21.41″)。**LG 官方的 30″ 嵌入框 MK2030NST 只配 2.0 立方英尺的 LMC2075，这台没有配套的嵌入框。**清单里的微波炉卡片改成了三个办法：',
    '| 办法 | 花费 | 说明 |',
    '|---|---|---|',
    '| **推荐**：换 LG LMC2075ST + MK2030NST 嵌入框 | 约 $259 + $259 ≈ **$520** | 外观和现在这台一样，官方配套。 |',
    '| Bosch 500 HMB50152UC（原生嵌入式） | **$999** | 不用嵌入框，最整齐 |',
  ].join('\n');
  const out = html(reply);
  assert.match(out, /<strong>LG 官方的 30″ 嵌入框 MK2030NST 只配 2\.0 立方英尺的 LMC2075，这台没有配套的嵌入框。<\/strong>清单里/);
  assert.match(out, /<table>/);
  assert.equal((out.match(/<th>/g) ?? []).length, 3);
  assert.equal((out.match(/<td>/g) ?? []).length, 6);
  assert.ok(!out.includes('**') && !out.includes('|---|'));
});
