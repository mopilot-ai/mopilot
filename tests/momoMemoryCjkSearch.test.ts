// MoMo's fact search in Chinese, Japanese and Korean (#2999, electron/momo/memoryFacts.cjs rankFacts and words): text with no spaces is matched by overlapping character pairs, so a question that shares part of a fact finds it, mixed with English words; unrelated text finds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rankFacts, words } = require('../electron/momo/memoryFacts.cjs');

let t = 0;
const fact = (id: string, text: string, confidence: 'sure' | 'likely' = 'likely') => ({
  id,
  text,
  source: 'user',
  confidence,
  createdAt: ++t,
});
const ids = (facts: any[], query: string, limit = 10) => rankFacts(facts, query, limit).map((f: any) => f.id);

test('a CJK run becomes overlapping character pairs; other runs stay whole words; one character stays itself', () => {
  assert.deepEqual(words('东京出差'), ['东京', '京出', '出差']);
  assert.deepEqual(words('去Tokyo出差 with Alice'), ['去', 'tokyo', '出差', 'with', 'alice']);
  assert.deepEqual(words('茶'), ['茶']);
  assert.deepEqual(words('東京へ行く'), ['東京', '京へ', 'へ行', '行く']);
  assert.deepEqual(words('서울 여행'), ['서울', '여행']);
  assert.deepEqual(words('ラーメン'), ['ラー', 'ーメ', 'メン'], 'the long-vowel mark belongs to the run');
  assert.deepEqual(words('  '), []);
});

test('a Chinese question that shares part of a fact finds it first, with no false hit from unrelated text', () => {
  const facts = [fact('trip', '下个月去东京出差两周'), fact('tea', '喜欢喝乌龙茶，不加糖', 'sure'), fact('cat', '家里养了一只叫团子的猫')];
  assert.deepEqual(ids(facts, '我下个月东京的行程是什么？'), ['trip']);
  assert.deepEqual(ids(facts, '她喜欢喝什么'), ['tea']);
  assert.deepEqual(ids(facts, '团子最近怎么样'), ['cat']);
  assert.deepEqual(ids(facts, '纽约天气'), [], 'no shared pair: nothing');
});

test('mixed Chinese and English terms add up; ties keep sure first, then newer', () => {
  const facts = [
    fact('a', '在 Berlin 的咖啡店上班'),
    fact('b', 'Drinks coffee every morning', 'sure'),
    fact('c', '喜欢 coffee 和咖啡豆', 'sure'),
  ];
  assert.deepEqual(ids(facts, 'Berlin 咖啡'), ['a', 'c']);
  assert.deepEqual(ids(facts, 'coffee'), ['c', 'b'], 'a tie: both sure, the newer first');
});

test('Japanese and Korean facts are found by part of a question, and a one-character question still matches', () => {
  const facts = [fact('jp', '来週は東京へ行く予定'), fact('kr', '주말에 서울 여행을 간다'), fact('one', '最爱喝茶')];
  assert.deepEqual(ids(facts, '東京の予定は'), ['jp']);
  assert.deepEqual(ids(facts, '서울 여행 언제'), ['kr']);
  assert.deepEqual(ids(facts, '茶'), ['one']);
});
