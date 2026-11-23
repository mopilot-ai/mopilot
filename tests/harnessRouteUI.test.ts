// A harness's route in the windows (src/harness/routes.ts, components/harness/RouteNotice.tsx, harnessPicker/RouteMark.tsx):
// main's answer kept once, the wording every surface uses, Show config file and Restart to apply.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { render, click, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: any[][] = [];
let listAnswer: Promise<any[]> = Promise.resolve([]);
let refreshAnswer: Promise<any[]> = Promise.resolve([]);
let changed: (list: any[]) => void = () => {};
let restartAnswer: () => Promise<any> = async () => ({ restarted: 1, busy: 0 });
let revealAnswer: () => Promise<boolean> = async () => true;
installNativeStub({
  routes: {
    list: () => listAnswer,
    refresh: () => (calls.push(['refresh']), refreshAnswer),
    onChanged: (cb: (list: any[]) => void) => ((changed = cb), () => {}),
    reveal: (k: string) => (calls.push(['reveal', k]), revealAnswer()),
    restartIdle: (k: string) => (calls.push(['restart', k]), restartAnswer()),
  },
});
stubStore({ toast: (text: string, kind: string) => calls.push(['toast', text, kind]) });
mock.module('../src/lib/paths.ts', { namedExports: { abbreviateHome: (p: string) => p.replace('/Users/u', '~') } });

const routes = await import('../src/harness/routes.ts');
const { RouteNotice, RouteUsageNote } = await import('../src/components/harness/RouteNotice.tsx');
const { RouteMark } = await import('../src/components/harnessPicker/RouteMark.tsx');

const entry = (p: any = {}) => ({
  harness: 'codex',
  kind: 'external',
  router: { id: 'magpie', label: 'magpie' },
  label: 'magpie',
  endpoint: 'http://127.0.0.1:3425',
  loopback: true,
  model: 'claude/claude-sonnet-5-5',
  provider: 'magpie',
  cloud: null,
  catalog: null,
  reasons: ['router', 'endpoint', 'model'],
  sources: [{ file: '/Users/u/.codex/config.toml', key: 'model_provider' }],
  file: '/Users/u/.codex/config.toml',
  error: null,
  signature: 's',
  changedAt: 1,
  lastGood: null,
  stale: { running: 0, idle: 0 },
  effects: [],
  ...p,
});

test('the wording: tag, sentence, stale note and usage note for every kind of route', () => {
  const ext = entry();
  assert.equal(routes.routeTag(ext as any), 'via magpie');
  assert.equal(
    routes.routeSentence(ext as any, 'Codex'),
    "Requests from Codex go through magpie at 127.0.0.1:3425. The model, the account that pays and the limits are magpie's, not your Codex sign-in's. ~/.codex/config.toml sets this, not MoPilot.",
  );
  // a remote host is named by where it is, a local one as a local gateway; neither is a name it gave itself
  const host = entry({
    label: 'api.moonshot.test',
    endpoint: 'https://api.moonshot.test',
    router: null,
    loopback: false,
    reasons: ['endpoint'],
    file: null,
  });
  assert.equal(
    routes.routeSentence(host as any, 'Codex'),
    "Requests from Codex go to api.moonshot.test instead of Codex's own service. The model, the account that pays and the limits are that endpoint's, not your Codex sign-in's.",
  );
  const local = entry({ label: 'local gateway', endpoint: 'http://127.0.0.1:34251', router: null, reasons: ['endpoint'], file: null });
  assert.equal(
    routes.routeSentence(local as any, 'Claude Code'),
    "Requests from Claude Code go to a local gateway at 127.0.0.1:34251 instead of Claude Code's own service. The model, the account that pays and the limits are that endpoint's, not your Claude Code sign-in's.",
  );
  assert.equal(routes.routeName(local as any), 'a local gateway');
  assert.equal(routes.routeName(host as any), 'api.moonshot.test');
  assert.equal(routes.routeName(ext as any), 'magpie');
  assert.match(String(routes.usageRouteNote(local as any, 'Claude Code')), /Requests now go through a local gateway, which may bill/);
  const noEndpoint = entry({ endpoint: null, reasons: ['router'] });
  assert.match(routes.routeSentence(noEndpoint as any, 'Goose'), /^Requests from Goose go through magpie\. /);
  const model = entry({ label: null, router: null, endpoint: null, reasons: ['model'] });
  assert.equal(routes.routeTag(model as any), 'model set outside MoPilot');
  assert.equal(
    routes.routeSentence(model as any, 'Codex'),
    "~/.codex/config.toml sets the model to claude/claude-sonnet-5-5, which isn't one of Codex's own models.",
  );
  assert.equal(
    routes.routeSentence({ ...model, file: null } as any, 'Codex'),
    "Its config sets the model to claude/claude-sonnet-5-5, which isn't one of Codex's own models.",
  );
  const cloud = entry({ cloud: 'Amazon Bedrock', label: 'Amazon Bedrock', reasons: ['cloud'], file: '/Users/u/.claude/settings.json' });
  assert.equal(
    routes.routeSentence(cloud as any, 'Claude Code'),
    'Claude Code runs on Amazon Bedrock, so that cloud account pays, not your Claude Code sign-in. ~/.claude/settings.json sets this, not MoPilot.',
  );
  const unknown = entry({ kind: 'unknown', error: "Couldn't read /x: Unexpected end", lastGood: { label: 'magpie' } });
  assert.equal(routes.routeTag(unknown as any), 'route unknown');
  assert.equal(
    routes.routeSentence(unknown as any, 'Codex'),
    "MoPilot couldn't read ~/.codex/config.toml (Unexpected end). It last read requests going through magpie.",
  );
  assert.equal(
    routes.routeSentence(entry({ kind: 'unknown', file: null, error: null }) as any, 'Codex'),
    "MoPilot couldn't read the config.",
  );
  const direct = entry({ kind: 'direct', label: null });
  assert.equal(routes.routeTag(direct as any), null);
  assert.equal(routes.routeSentence(direct as any, 'Codex'), '');
  assert.equal(routes.usageRouteNote(direct as any, 'Codex'), null);
  assert.equal(routes.usageRouteNote(model as any, 'Codex'), null);
  assert.match(
    String(routes.usageRouteNote(ext as any, 'Codex')),
    /^These limits are your Codex sign-in's\. Requests now go through magpie/,
  );

  const stale = (running: number, idle: number) => routes.staleText(entry({ stale: { running, idle } }) as any, 'Codex');
  assert.equal(stale(0, 0), null);
  const lead = 'The config changed after Codex started, so it still runs on the old one.';
  assert.equal(stale(0, 2), lead);
  assert.equal(stale(1, 0), `${lead} Restart to apply once its running chat finishes.`);
  assert.equal(stale(3, 0), `${lead} Restart to apply once its 3 running chats finish.`);
  assert.equal(stale(1, 1), `${lead} A chat still working keeps the old config until you restart again.`);
  assert.equal(stale(2, 1), `${lead} 2 chats still working keep the old config until you restart again.`);

  assert.equal(routes.hostOf(null), null);
  assert.equal(routes.routeShown(null), false);
  assert.equal(routes.routeShown(direct as any), false);
  assert.equal(routes.routeShown(entry({ kind: 'direct', stale: { running: 1, idle: 0 } }) as any), true);
  assert.equal(routes.routeShown(entry({ kind: 'direct', effects: ['poolingOff'] }) as any), true);
});

test("the picker's header: a provider MoPilot chose wins; otherwise the route's router; otherwise what the chat has", () => {
  const mp = { label: 'MoPilot', firstParty: false };
  const own = { label: 'Anthropic', firstParty: true };
  assert.equal(routes.headerProvider(mp, entry() as any), mp);
  assert.deepEqual(routes.headerProvider(own, entry() as any), { label: 'magpie', firstParty: false });
  assert.equal(routes.headerProvider(own, entry({ label: null }) as any), own);
  assert.equal(routes.headerProvider(null, null), null);
  assert.equal(routes.headerProvider(undefined, entry({ kind: 'direct' }) as any), null);
});

test("main's answer is kept once for every component, pushed changes replace it, and focus reads the files again", async () => {
  listAnswer = Promise.resolve([entry({ harness: 'claude', label: 'gateway one' })]);
  const v = await render(h(RouteMark, { harness: 'claude', label: 'Claude Code' }));
  await flush();
  assert.match(v.host.textContent!, /gateway one/);
  changed([entry({ harness: 'claude', label: 'gateway two' })]);
  await flush();
  assert.match(v.host.textContent!, /gateway two/);
  refreshAnswer = Promise.resolve([entry({ harness: 'claude', label: 'gateway three' })]);
  window.dispatchEvent(new Event('focus'));
  await flush();
  assert.match(v.host.textContent!, /gateway three/);
  assert.ok(calls.some((c) => c[0] === 'refresh'));
  // a failed read keeps the last answer
  refreshAnswer = Promise.reject(new Error('main is busy'));
  window.dispatchEvent(new Event('focus'));
  await flush();
  assert.match(v.host.textContent!, /gateway three/);
  await v.unmount();
});

test('the mark on the model pill: only for a route set outside MoPilot, and not while MoPilot chose the provider', async () => {
  changed([
    entry(),
    entry({ harness: 'claude', kind: 'direct', label: null }),
    entry({ harness: 'acp:x', label: null, reasons: ['model'] }),
  ]);
  const one = async (props: any) => {
    const v = await render(h(RouteMark, props));
    const el = v.host.querySelector('.route-mark');
    const out = el && { text: el.textContent, title: el.getAttribute('title'), aria: el.getAttribute('aria-label') };
    await v.unmount();
    return out;
  };
  const shown = await one({ harness: 'codex', label: 'Codex' });
  assert.equal(shown!.text, '⇄ magpie');
  assert.equal(shown!.title, shown!.aria);
  assert.match(shown!.title!, /^Requests from Codex go through magpie/);
  assert.equal(await one({ harness: 'codex', label: 'Codex', hidden: true }), null);
  assert.equal(await one({ harness: 'claude', label: 'Claude Code' }), null);
  assert.equal(await one({ harness: 'nope', label: 'Nope' }), null);
  assert.equal((await one({ harness: 'acp:x', label: 'X' }))!.text, '⇄ custom model');
});

test('the note under a row: where requests go, what it turned off, Show config file; nothing when all is as the vendor has it', async () => {
  changed([
    entry({ effects: ['poolingOff'] }),
    entry({ harness: 'claude', kind: 'direct', label: null }),
    entry({
      harness: 'acp:g',
      label: 'api.example.test',
      endpoint: 'https://api.example.test',
      model: null,
      file: null,
      effects: ['poolingOff'],
    }),
  ]);
  calls.length = 0;
  const v = await render(h(RouteNotice, { harness: 'codex', label: 'Codex' }));
  const note = v.host.querySelector('[data-route="codex"]')!;
  assert.ok(note.classList.contains('route-note-row') && note.classList.contains('external'));
  assert.equal(note.querySelector('.route-tag')!.textContent, '⇄ via magpie');
  assert.equal(note.querySelector('.route-details')!.textContent, 'claude/claude-sonnet-5-5 · 127.0.0.1:3425');
  const texts = [...note.querySelectorAll('.route-text')].map((e) => e.textContent);
  assert.match(texts[0]!, /^Requests from Codex go through magpie/);
  assert.equal(texts[1], "MoPilot's account pooling is off while requests go through magpie.");
  const show = note.querySelector('.link-btn') as HTMLButtonElement;
  assert.equal(show.getAttribute('aria-label'), 'Show ~/.codex/config.toml in Finder');
  await click(show);
  assert.deepEqual(calls.at(-1), ['reveal', 'codex']);
  revealAnswer = async () => {
    throw new Error('no Finder');
  };
  await click(show);
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't show the config file: no Finder", 'error']);
  // no Restart to apply while nothing runs on the old config
  assert.equal(note.querySelector('.btn-pill'), null);
  await v.unmount();
  const none = await render(h(RouteNotice, { harness: 'claude', label: 'Claude Code' }));
  assert.equal(none.host.innerHTML, '');
  await none.unmount();
  // a host that is its own label isn't repeated; no file, no button; the effect names the route's label
  const g = await render(h(RouteNotice, { harness: 'acp:g', label: 'Gemini', variant: 'card' }));
  assert.ok(g.host.querySelector('.route-note-card'));
  assert.equal(g.host.querySelector('.route-details'), null);
  assert.equal(g.host.querySelector('.link-btn'), null);
  assert.equal(
    [...g.host.querySelectorAll('.route-text')][1].textContent,
    "MoPilot's account pooling is off while requests go through api.example.test.",
  );
  await g.unmount();
});

test('unknown: the tag and why, no details; pooling stays off until MoPilot reopens once the route is gone', async () => {
  changed([
    entry({ kind: 'unknown', label: null, error: 'bad', effects: ['poolingOff'] }),
    entry({ harness: 'claude', label: null, reasons: ['model'], effects: ['poolingOff'] }),
  ]);
  const v = await render(h(RouteNotice, { harness: 'codex', label: 'Codex' }));
  assert.ok(v.host.querySelector('.route-note.unknown'));
  assert.equal(v.host.querySelector('.route-tag')!.textContent, '⇄ route unknown');
  assert.equal(v.host.querySelector('.route-details'), null);
  // the relay is decided when MoPilot starts: a route that went keeps it off until then
  assert.equal(
    [...v.host.querySelectorAll('.route-text')][1].textContent,
    "MoPilot's account pooling stays off until you quit and reopen MoPilot.",
  );
  await v.unmount();
  const m = await render(h(RouteNotice, { harness: 'claude', label: 'Claude Code' }));
  assert.equal(
    [...m.host.querySelectorAll('.route-text')][1].textContent,
    "MoPilot's account pooling is off while requests go through another endpoint.",
  );
  await m.unmount();
});

test('Restart to apply: restarts the idle processes, says what happened, and is busy while it runs', async () => {
  changed([entry({ kind: 'direct', label: null, router: null, stale: { running: 1, idle: 1 } })]);
  calls.length = 0;
  let release: (v: any) => void = () => {};
  restartAnswer = () => new Promise((r) => (release = r));
  const v = await render(h(RouteNotice, { harness: 'codex', label: 'Codex' }));
  // a direct route on an old process: no tag or sentence, only the stale note
  assert.equal(v.host.querySelector('.route-tag'), null);
  assert.equal(v.host.querySelectorAll('.route-text').length, 1);
  assert.match(v.host.querySelector('.route-stale')!.textContent!, /^The config changed after Codex started/);
  const btn = v.host.querySelector('.btn-pill') as HTMLButtonElement;
  assert.equal(btn.textContent, 'Restart to apply');
  await click(btn);
  assert.equal(btn.textContent, 'Restarting…');
  assert.equal(btn.disabled, true);
  release({ restarted: 1, busy: 0 });
  await flush();
  assert.deepEqual(calls.slice(-2), [
    ['restart', 'codex'],
    ['toast', 'Codex restarted on its current config', 'success'],
  ]);
  assert.equal(btn.disabled, false);
  restartAnswer = async () => ({ restarted: 0, busy: 1 });
  await click(btn);
  assert.deepEqual(calls.at(-1), ['toast', 'Codex is still working; restart once it is done', 'info']);
  restartAnswer = async () => ({ restarted: 0, busy: 0 });
  const before = calls.length;
  await click(btn);
  assert.equal(calls.length, before + 1);
  restartAnswer = async () => {
    throw new Error('it quit');
  };
  await click(btn);
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't restart Codex: it quit", 'error']);
  await v.unmount();
});

test('beside account usage: only while requests go through a named route', async () => {
  changed([entry(), entry({ harness: 'claude', kind: 'direct', label: null })]);
  const v = await render(
    h('div', null, h(RouteUsageNote, { harness: 'codex', label: 'Codex' }), h(RouteUsageNote, { harness: 'claude', label: 'Claude Code' })),
  );
  const notes = [...v.host.querySelectorAll('[data-route-usage]')];
  assert.deepEqual(
    notes.map((n) => n.getAttribute('data-route-usage')),
    ['codex'],
  );
  assert.equal(notes[0].querySelector('.route-tag')!.textContent, '⇄ via magpie');
  assert.match(notes[0].querySelector('.route-text')!.textContent!, /^These limits are your Codex sign-in's/);
  await v.unmount();
  const none = await render(h(RouteUsageNote, { harness: 'unread', label: 'X' }));
  assert.equal(none.host.innerHTML, '');
  await none.unmount();
});

test("a list read that fails at start leaves nothing shown until main's next answer", async () => {
  // the store already started; this is its first-read failure path, exercised through a fresh module copy
  const fresh = await import(`../src/harness/routes.ts?fresh=${Date.now()}`);
  listAnswer = Promise.reject(new Error('not ready'));
  const v = await render(
    h(() => {
      const r = fresh.useHarnessRoute('codex');
      return h('span', null, r ? 'shown' : 'none');
    }),
  );
  await flush();
  assert.equal(v.host.textContent, 'none');
  await v.unmount();
});

test('a malformed endpoint has safe useful wording without pretending its address is known', () => {
  const r = entry({ router: null, label: 'custom endpoint', endpoint: null, loopback: false, reasons: ['endpoint'] });
  assert.match(routes.routeSentence(r, 'Codex'), /^Requests from Codex go to a custom endpoint instead of/);
  assert.equal(routes.routeSentence(r, 'Codex').includes('null'), false);
});
