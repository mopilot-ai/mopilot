// Claude-style panel states are checked in Chrome's actual per-tab frame, with native trusted card clicks and local pages only.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';
import { submitNativePanel } from './fixtures/nativePanelSend.mjs';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');
let server: http.Server;
let approvalServer: http.Server;
let site = '';
let approvalSite = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Panel design fixture</title><h1>Local page</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  approvalServer = http.createServer((_req, res) =>
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><title>Panel design fixture</title><h1>Local approval page</h1>'),
  );
  await new Promise<void>((resolve) => approvalServer.listen(0, '127.0.0.1', resolve));
  approvalSite = `http://127.0.0.1:${(approvalServer.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
  approvalServer.closeAllConnections();
  approvalServer.close();
});
test.describe.configure({ timeout: 240_000 });
for (const kind of ['codex', 'claude'] as const)
  test.describe(kind, () => {
    test.use({ harnesses: kind });
    test(`native panel design on ${kind}: empty, model selection, approvals, repeated steps, screenshot, Stop and completed Markdown`, async ({
      page,
      launchChrome,
    }, info) => {
      const chrome = await launchChrome();
      const welcome = await pairWithAllow(page, chrome);
      const front = await chrome.context.newPage();
      await front.goto(site);
      const side = await chrome.sidePanel(welcome, front);
      // No side.panel() fallback: every screenshot and control below belongs to the native side-panel frame.
      await completePanelFirstRun(side);
      await expect.poll(() => side.inPanel(`document.getElementById('harness')?.options.length`)).toBeGreaterThan(0);
      await expect.poll(() => side.inPanel(`document.getElementById('model').textContent`)).not.toBe('Choose model');
      const empty = await side.inPanel(
        `({ toolbar:[...document.querySelectorAll('.bar > button')].filter(b=>!b.hidden).map(b=>b.id), title:document.getElementById('task-title').hidden, mark:!!document.querySelector('#empty .empty-mark'), placeholder:document.getElementById('text').placeholder, modelMenu:document.getElementById('model-menu').hidden })`,
      );
      expect(empty).toEqual({
        toolbar: ['side', 'new', 'more'],
        title: true,
        mark: true,
        placeholder: 'Ask anything',
        modelMenu: true,
      });
      expect(await side.inPanel(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true);
      await expect
        .poll(() =>
          side.inPanel(`['model','mic','send'].every(id => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return rect.width > 0 && rect.left >= 0 && rect.right <= document.documentElement.clientWidth;
      })`),
        )
        .toBe(true);
      await side.screenshot(info.outputPath('empty.png'));
      await side.click('#model');
      await expect.poll(() => side.inPanel(`document.getElementById('model-menu').hidden`)).toBe(false);
      await side.inPanel(
        `(() => { const h=document.getElementById('harness'); h.value=${JSON.stringify(kind)}; h.dispatchEvent(new Event('change')); })()`,
      );
      await expect.poll(() => side.inPanel(`document.getElementById('model-menu').hidden`)).toBe(true);
      await expect
        .poll(() => side.inPanel(`!document.getElementById('perm').hidden && !document.getElementById('perm').disabled`))
        .toBe(true);
      await side.click('#perm');
      await expect
        .poll(() =>
          side.inPanel(`[...document.querySelectorAll('#perm-menu button')].some(b=>b.textContent.startsWith('Ask for approval'))`),
        )
        .toBe(true);
      const askIndex = await side.inPanel(
        `[...document.querySelectorAll('#perm-menu button')].findIndex(b=>b.textContent.startsWith('Ask for approval')) + 1`,
      );
      expect(askIndex).toBeGreaterThan(0);
      await side.click(`#perm-menu button:nth-of-type(${askIndex})`);
      const tabId = await welcome.evaluate(
        async (url) => (await (globalThis as any).chrome.tabs.query({})).find((t: any) => t.url === url).id,
        site,
      );
      const send = (text: string) => submitNativePanel(side, text);
      const tool = (name: string) => (kind === 'claude' ? `mcp__mopilot_chrome__${name}` : `chrome_${name}`);
      await send(
        `CUSTEPS\nCUCALL ${tool('navigate')} ${JSON.stringify({ tabId, url: approvalSite })}\nCUCALL ${tool('read_page')} ${JSON.stringify({ tabId, filter: 'all' })}\nCUCALL ${tool('computer')} ${JSON.stringify({ tabId, action: 'screenshot' })}\nCUCALL ${tool('computer')} ${JSON.stringify({ tabId, action: 'screenshot' })}\nSLOW`,
      );
      await expect
        .poll(() => side.inPanel(`document.getElementById('cards').textContent`), { timeout: 30000 })
        .toContain('Allow in this chat');
      await expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`)).toBe('Waiting for you');
      await side.screenshot(info.outputPath('approval.png'));
      await side.click('#cards button[data-choice="chat"]');
      await expect
        .poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 30000 })
        .toBe('Using your Chrome');
      await expect.poll(() => side.inPanel(`document.querySelectorAll('#rows .step-thumbnail').length`)).toBe(1);
      expect(await side.inPanel(`document.getElementById('activity-thumbnail').src`)).toMatch(/^data:image\//);
      await side.screenshot(info.outputPath('running.png'));
      await front.screenshot({ path: info.outputPath('page-indicator.png') });
      await side.click('#rows details.steps > summary');
      await side.click('#rows details.step > summary');
      expect(await side.inPanel(`document.querySelector('#rows details.step pre').textContent`)).toContain('Input');
      await side.screenshot(info.outputPath('step-details.png'));
      await side.click('#stop');
      // the user stopped the turn: its last history turn is `interrupted` on both harnesses (#3046, B2), not "Done"
      await expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 30000 }).toBe('Stopped');
      await send('Formatting\n\n1. First\n\n2. Second\n\n| Item | Value |\n| --- | --- |\n| Cancel | Free |\n\n```text\nCopy me\n```');
      await expect.poll(() => side.inPanel(`document.querySelectorAll('#rows .reply table td').length`), { timeout: 30000 }).toBe(2);
      await expect.poll(() => side.inPanel(`document.getElementById('title').textContent`), { timeout: 90000 }).toBe('Fake chat title');
      const completed = await side.inPanel(
        `({ items:[...document.querySelectorAll('#rows .reply ol li')].map(x=>x.textContent), codeCopy:!!document.querySelector('pre button[data-panel-copy="Copy me"]'), width:document.getElementById('chat').scrollWidth <= document.getElementById('chat').clientWidth, placeholder:document.getElementById('text').placeholder, footer:document.querySelector('.footer').textContent })`,
      );
      expect(completed.items).toEqual(['First', 'Second']);
      expect(completed.codeCopy).toBe(true);
      expect(completed.width).toBe(true);
      expect(await side.inPanel(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true);
      expect(completed.placeholder).toBe('Write a message…');
      expect(completed.footer).toContain('Please double-check responses.');
      await side.click('#rows .reply pre button[data-panel-copy]');
      await expect.poll(() => side.inPanel(`document.getElementById('copy-notice').textContent`)).toBe('Copied');
      await side.screenshot(info.outputPath('completed.png'));
      // Another surface changes this chat's saved model. A plain panel send must use it, not replay its old menu.
      await side.inPanel(`(() => {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        globalThis.__restoreModelSend = () => { chrome.runtime.sendMessage = original; };
        chrome.runtime.sendMessage = message => {
          if (message.type === 'panel' && message.method === 'send' && message.params.text === 'Use current model')
            globalThis.__modelSend = message.params;
          return original(message);
        };
      })()`);
      try {
        const changedLabel = await side.inPanel(`(async () => {
          const chatId = document.getElementById('chat').dataset.chatId;
          const options = (await chrome.runtime.sendMessage({type:'panel',method:'options',params:{chatId}})).result;
          const next = options.models.find(model => model.id !== options.model);
          if (!next) throw new Error('The fake harness must offer two models for this check');
          const reply = await chrome.runtime.sendMessage({type:'panel',method:'choose',params:{chatId,model:next.id,effort:next.defaultEffort}});
          if (reply.error) throw new Error(reply.error);
          return next.label;
        })()`);
        await send('Use current model');
        await expect.poll(() => side.inPanel(`globalThis.__modelSend && Object.hasOwn(globalThis.__modelSend,'model')`)).toBe(false);
        await expect.poll(() => side.inPanel(`document.getElementById('model').textContent`), { timeout: 30_000 }).toContain(changedLabel);
      } finally {
        await side.inPanel(`globalThis.__restoreModelSend()`);
      }
      await side.click('#more');
      await expect.poll(() => side.inPanel(`document.getElementById('header-menu').hidden`)).toBe(false);
      await side.screenshot(info.outputPath('more-menu.png'));
      await side.click('#more');
      // Renderer fault injection only: no native send occurs for this marker, and Open never launches another app.
      await side.inPanel(`(() => {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        globalThis.__restorePanelSend = () => { chrome.runtime.sendMessage = original; };
        chrome.runtime.sendMessage = message => {
          if (message.type === 'panel' && message.method === 'send' && message.params.text === 'Retain failed input')
            return new Promise(resolve => { globalThis.__failPanelSend = resolve; });
          if (message.type === 'panel' && message.method === 'open') return Promise.resolve({status:'connected',error:'Another action failed'});
          return original(message);
        };
      })()`);
      try {
        await send('Retain failed input');
        await expect.poll(() => side.inPanel(`typeof globalThis.__failPanelSend`)).toBe('function');
        await side.inPanel(`(() => {
          const box = document.getElementById('text'); box.value = 'Independent new draft'; box.dispatchEvent(new Event('input'));
          globalThis.__failPanelSend({status:'connected',error:'Injected send refusal'});
        })()`);
        await expect.poll(() => side.inPanel(`document.getElementById('error').textContent`)).toContain('Retain failed input');
        expect(await side.inPanel(`document.getElementById('text').value`)).toBe('Independent new draft');
        await side.click('#more');
        await side.click('#app');
        await expect.poll(() => side.inPanel(`document.getElementById('error').textContent`)).toContain('Another action failed');
        expect(await side.inPanel(`document.querySelector('#error details').open`)).toBe(true);
        await side.click('#error [data-panel-copy]');
        await expect.poll(() => side.inPanel(`document.getElementById('copy-notice').textContent`)).toBe('Copied');
        await side.screenshot(info.outputPath('retained-message.png'));
      } finally {
        await side.inPanel(`globalThis.__restorePanelSend()`);
      }
    });
  });
