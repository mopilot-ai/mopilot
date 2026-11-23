// The unsignalled-wait lint guard (lint/rules/unsignalled-wait.grit): an approval card asked without the tool call's
// abort signal warns (#1865); a card given the signal, or `{ signal: null }`, and other asks stay valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('a broker card or site check without the call signal warns; one with it stays valid', () => {
  for (const [input, expected] of [
    // the broker, with no options
    ["const f = async (chatId) => this.broker.ask(chatId, 'computerConfirm', { verb: 'x' });", 1],
    ["const f = async (live, chatId) => live.computerUse.broker.ask(chatId, 'devServer', {});", 1],
    ["const f = async (broker, chatId) => broker.ask(chatId, 'visionConsent', {});", 1],
    ["const f = async (broker, chatId) => broker.ask(chatId, 'visionConsent');", 1],
    // ... and with the call's signal, or none on purpose
    ["const f = async (chatId, ctx) => this.broker.ask(chatId, 'computerConfirm', {}, { signal: ctx.signal });", 0],
    ["const f = async (broker, chatId) => broker.ask(chatId, 'browserPermission', {}, { signal: null });", 0],
    // another ask is not the broker's
    ['const f = async (handoff, chatId) => handoff.ask(chatId, 1, 2);', 0],
    // a site check given a context with no signal
    ["const f = async (grants, url) => grants.require(url, 'read', this.ctx, { offer: 'write' });", 1],
    ["const f = async (grants, url, chatId) => grants.require(url, 'read', { chatId, segmentId: 's' });", 1],
    ['const f = async (grants, url) => grants.act(url, this.ctx, { tool: "click" });', 1],
    ['const f = async (grants, url, chatId) => grants.act(url, { chatId });', 1],
    // ... and with the call's ctx or signal
    ["const f = async (grants, url, ctx) => grants.require(url, 'read', ctx);", 0],
    ["const f = async (grants, url) => grants.require(url, 'read', { ...this.ctx, signal: stopSignal() }, {});", 0],
    ['const f = async (grants, url, ctx) => grants.act(url, ctx, { tool: "click" });', 0],
    ['const f = async (grants, url) => grants.act(url, { ...this.ctx, signal: stopSignal() }, {});', 0],
  ] as const) {
    const report = lintFixtures({ 'electron/card.cjs': `${input}\n` });
    const hits = report.diagnostics.filter((d: any) => d.message.includes('[unsignalled-wait]'));
    assert.equal(hits.length, expected, input);
  }
});
