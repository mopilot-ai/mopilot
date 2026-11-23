// Shared task services, fake comparison driver, page, and Chrome transport fixtures for comparison unit cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TASKS, UPLOAD_TEXT, ACCOUNT, selectTasks, fixturePages } from '../../../scripts/chrome-compare/tasks.mjs';
import { startFixtureServer } from '../../../scripts/chrome-compare/server.mjs';
import { callsFromLog, summarize, table } from '../../../scripts/chrome-compare/metrics.mjs';
import {
  ARMS,
  HARNESSES,
  chromeHomes,
  canonical,
  parseArgs,
  refusal,
  otherChromes,
  runComparison,
  main,
  psCommands,
  importModule,
} from '../../../scripts/chrome-compare/run.mjs';
import { electronDriver, chromeBin, HOLD_MS, DESKTOP_DECLINE } from '../../../scripts/chrome-compare/driver.mjs';
import { cdpPipe, startExtensionChrome, PAIR_SCRIPT } from '../../../scripts/chrome-compare/extension.mjs';

const require = createRequire(import.meta.url);
const { spawnSpec } = require('../../../electron/capabilities/browser/extension.cjs');
const { insideVirtualMachine } = require('../../../scripts/release-suites.cjs');

const post = (url: string, body: any) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** A fake driver: answers per task, records what it was asked. */
function fakeDriver(answer: (prompt: string) => any) {
  const log: any[] = [];
  return {
    log,
    start: async (arm: string, cfg: any) => (log.push(['start', arm, cfg.flags]), { arm }),
    runTask: async (s: any, t: any) => (log.push(['run', s.arm, t.harness]), answer(t.prompt)),
    stop: async (s: any) => log.push(['stop', s.arm]),
  };
}

/** A fake Playwright page: the controls the driver uses, scripted per test. */
function fakePage(o: {
  stopPolls: number;
  cards?: number;
  answers?: string[];
  hash?: string;
  stuckCard?: boolean;
  quietPolls?: number;
  desktopCards?: number;
  /** a basic (ACP) harness: its row closes the picker, and the model button reads `label` */
  basic?: boolean;
  label?: string;
}) {
  let desktop = o.desktopCards ?? 0;
  let quiet = o.quietPolls ?? 0;
  const clicks: string[] = [];
  const holds: number[] = [];
  let stop = o.stopPolls;
  let cards = o.cards ?? 0;
  const loc = (name: string, count = () => 1): any => ({
    first: () => loc(name, count),
    click: async (opts: any = {}) => {
      clicks.push(name);
      if (name === 'allow') cards--, holds.push(opts.delay);
      if (name === 'decline') desktop--;
    },
    count: async () => count(),
    fill: async (v: string) => clicks.push(`fill:${v.slice(0, 20)}`),
    allInnerTexts: async () => o.answers ?? [],
    innerText: async () => o.label ?? '',
  });
  // the card takes the composer's place: while one waits there is no Stop button
  const locators: Record<string, any> = {
    'button.send-btn.stop, button.approval-stop': loc('stop', () => (cards > 0 || desktop > 0 || o.stuckCard ? 0 : stop-- > 0 ? 1 : 0)),
    '.approval-card': loc('card', () => (cards > 0 || desktop > 0 || o.stuckCard ? 1 : 0)),
    [DESKTOP_DECLINE]: loc('decline', () => (desktop > 0 ? 1 : 0)),
    '.approval-card button.ap-btn.allow:not(.chevron)': loc('allow', () => (cards > 0 ? 1 : 0)),
    '.hp-models': loc('models', () => (o.basic ? 0 : 1)),
    // before the turn shows it started, there is no answer either
    '.assistant-message': loc('answers', () => (quiet-- > 0 ? 0 : (o.answers ?? []).length)),
  };
  return {
    clicks,
    holds,
    page: {
      getByRole: (_role: string, { name }: any) => loc(String(name)),
      locator: (sel: string, opts: any = {}) => locators[sel] ?? loc(`${sel}${opts.hasText ? `:${opts.hasText}` : ''}`),
      evaluate: async () => o.hash ?? 'chat-1',
    },
  };
}

/**
 * A fake Chrome on its DevTools pipe: answers each method from `answers` (a value, or a function of the params and
 * session), records what it was sent, and can emit events. A unit test never starts a real browser.
 */
/** The Target.getTargets answer of a Chrome that runs the extension `id`. */
const ext = (id: string) => ({ targetInfos: [{ type: 'service_worker', url: `chrome-extension://${id}/background.js`, targetId: 'sw' }] });

function fakeChrome(answers: Record<string, any>) {
  const sent: any[] = [];
  const spawned: any[] = [];
  const out = new EventEmitter();
  const reply = (m: any) => out.emit('data', `${JSON.stringify(m)}\0`);
  const input = {
    write: (s: string) => {
      const m = JSON.parse(s.slice(0, -1));
      sent.push(m);
      const a = answers[m.method];
      // a method with no answer is never answered (Chrome hangs on it)
      if (a === undefined && !(m.method in answers)) return;
      const v = typeof a === 'function' ? a(m.params, m.sessionId) : a;
      setImmediate(() => {
        if (v instanceof Error) reply({ id: m.id, error: { message: v.message } });
        else {
          reply({ id: m.id, result: v });
          if (m.method === 'Browser.close' && child.autoExit)
            setImmediate(() => {
              child.exitCode = 0;
              child.emit('exit', 0);
            });
        }
      });
    },
  };
  const child: any = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, input, out],
    killed: 0,
    pid: 123,
    exitCode: null,
    signalCode: null,
    autoExit: true,
  });
  // the killed process exits before any timer can run: a test's few-millisecond exit deadline must not race the event
  // loop (a loaded runner fired the deadline first and counted a second kill)
  child.kill = () => {
    child.killed++;
    queueMicrotask(() => {
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
    });
  };
  const spawn: any = (cmd: string, args: string[], opts: any) => (spawned.push([cmd, args, opts]), child);
  const emit = (method: string, params: any) => out.emit('data', `${JSON.stringify({ method, params })}\0`);
  return { sent, spawned, out, spawn, emit, child };
}

export {
  test,
  assert,
  fs,
  os,
  path,
  ARMS,
  electronDriver,
  chromeBin,
  HOLD_MS,
  DESKTOP_DECLINE,
  spawnSpec,
  fakePage,
  fakeChrome,
  ext,
  EventEmitter,
  cdpPipe,
  startExtensionChrome,
  PAIR_SCRIPT,
  spawnSync,
  TASKS,
  selectTasks,
  HARNESSES,
  chromeHomes,
  canonical,
  parseArgs,
  refusal,
  otherChromes,
  runComparison,
  psCommands,
  importModule,
  insideVirtualMachine,
  fakeDriver,
  UPLOAD_TEXT,
  main,
  ACCOUNT,
  fixturePages,
  startFixtureServer,
  callsFromLog,
  summarize,
  table,
  post,
};
