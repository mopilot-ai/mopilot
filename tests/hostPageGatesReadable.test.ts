// hostPageGates.cjs readable: whether a page diff may read a tab without asking, as pageGate would let a read through
// (moved here from hostTools.cjs with G3's hidden-text hints): an allowed site yes, a refused one no, a site that would
// ask only when it is an ordinary one without credentials, and any refusal while checking no.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pageGates } = require('../electron/capabilities/browser/hostPageGates.cjs');

function gatesWith(peek: string, risk: any = { level: 'normal', credentials: false }) {
  const grants = { peek: () => peek, riskOf: () => risk, blockNote: () => 'blocked' };
  return pageGates({ grants, tabs: { awaitUser: async (_t: any, p: any) => p }, live: () => {} });
}

test('readable: allowed yes, a card it would raise only for an ordinary site, refusals no', () => {
  const tab = { url: 'https://shop.test/' };
  assert.equal(gatesWith('ok').readable(tab, {}), true);
  assert.equal(gatesWith('ask').readable(tab, {}), true);
  assert.equal(gatesWith('ask', { level: 'high', credentials: false }).readable(tab, {}), false);
  assert.equal(gatesWith('ask', { level: 'normal', credentials: true }).readable(tab, {}), false);
  // a write that would ask again on a read-only site is no read refusal; a denied or blocked site throws, which is a no
  assert.equal(gatesWith('reask').readable(tab, { siteAllowed: new Set(['https://shop.test']) }), false);
  assert.equal(gatesWith('denied').readable(tab, {}), false);
  assert.equal(gatesWith('blocked').readable(tab, {}), false);
});
