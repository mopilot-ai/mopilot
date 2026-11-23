// The phone tests' React Native shim is as strict as the device about text: a string or number directly inside a View or Pressable throws, as it does on iOS and Android.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/phone/register.ts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Pressable, SafeAreaView, ScrollView, Text, View } from './support/phone/native.tsx';

const h = React.createElement;
const html = (element: React.ReactElement) => renderToStaticMarkup(element);
const RAW = /Text strings must be rendered within a <Text> component/;

test('text inside a Text is fine, wherever the Text sits', () => {
  assert.match(html(h(View, null, h(Text, null, 'hello'), h(View, null, h(Text, null, 7, ' items')))), /hello.*7.*items/);
  assert.match(html(h(Text, null, 'plain ', 3)), /plain/);
});

test('a string or number directly inside a View, SafeAreaView, ScrollView or Pressable throws', () => {
  for (const Box of [View, SafeAreaView, ScrollView, Pressable]) {
    assert.throws(() => html(h(Box as any, null, 'loose text')), RAW, `${(Box as any).name || 'component'} string`);
    assert.throws(() => html(h(Box as any, null, h(Text, null, 'fine'), 42)), RAW, 'a number');
  }
  assert.throws(() => html(h(View, null, ' ')), RAW, 'a space is text too');
});

test('a string inside a fragment or a list is still a direct child of the View', () => {
  assert.throws(() => html(h(View, null, h(React.Fragment, null, 'in a fragment'))), RAW);
  assert.throws(() => html(h(View, null, ['a', h(Text, { key: 'k' }, 'b')])), RAW);
});

test('nothing, false, null and the empty string render nothing and do not throw', () => {
  assert.doesNotThrow(() => html(h(View, null, null, false, undefined, '', h(Text, null, 'ok'))));
  assert.doesNotThrow(() => html(h(Pressable, null, false && 'hidden')));
});

test('a pair id is made of what a SecureStore key may hold, since the title keys are stored under it', async () => {
  const { createRequire } = await import('node:module');
  const E = await import('../shared/remote/envelope.mjs');
  const C = await import('../shared/remote/crypto.mjs');
  const { createSodiumPrimitives } = createRequire(import.meta.url)('../electron/remote/sodiumPrimitives.cjs');
  const { checkSecureKey } = await import('./support/phone/secure-store-rules.ts');
  const crypto = C.createCrypto(createSodiumPrimitives());
  for (let i = 0; i < 300; i++) {
    const code = Uint8Array.from({ length: 32 }, (_, n) => (n * 31 + i * 7 + (i >> 3)) & 255);
    assert.doesNotThrow(() => checkSecureKey(`title-key.${crypto.pairId(code)}`), E.toHex(code));
  }
  assert.throws(() => checkSecureKey('title-key.p_a/b'), /Invalid key/);
  assert.throws(() => checkSecureKey('has space'), /Invalid key/);
  assert.throws(() => checkSecureKey(''), /Invalid key/);
  assert.throws(() => checkSecureKey(5 as any), /Invalid key/);
});

test('a SecureStore value must be a string', async () => {
  const { checkSecureValue } = await import('./support/phone/secure-store-rules.ts');
  assert.doesNotThrow(() => checkSecureValue('abc'));
  assert.doesNotThrow(() => checkSecureValue(''));
  assert.throws(() => checkSecureValue({ a: 1 }), /Invalid value/);
  assert.throws(() => checkSecureValue(null), /Invalid value/);
});
