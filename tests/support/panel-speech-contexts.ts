// The real side-panel speech entry carries its selected chat and project into capture ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelPage } from './side-panel-page.ts';
import { tick } from './extension-background/fixture.ts';
export function registerPanelSpeechContexts(page: () => any, startSidePanel: (g: any) => any) {
  test('the speech capture targets an existing chat and an explicitly selected project', async () => {
    for (const existing of [false, true]) {
      const p = panelPage({
        reply: (m: any) => {
          const result =
            m.method === 'harnesses'
              ? { harnesses: [{ id: 'claude', label: 'Claude Code' }] }
              : m.method === 'projects'
                ? { projects: [{ id: 'p1', name: 'Project' }] }
                : m.method === 'recent'
                  ? { chats: [{ id: 'chat', title: 'Existing', project: 'Project', state: 'idle', pinned: true }] }
                  : m.method === 'dictationEngine'
                    ? { engine: 'chatgpt', capture: 'held' }
                    : { rows: [], state: 'idle' };
          return { status: 'connected', result };
        },
      });
      const mic = page();
      Object.assign(p.g, mic.g);
      await startSidePanel(p.g).ready;
      await tick();
      p.els.side.listeners.click();
      await tick();
      await tick();
      if (existing) p.els.pinned.children[0].children[0].listeners.click();
      else {
        p.els.projects.children[1].listeners.click();
        p.els['side-new'].listeners.click();
      }
      await tick();
      p.els.mic.listeners.click();
      await tick();
      await tick();
      const target = p
        .sent()
        .filter((m: any) => m.method === 'dictationEngine')
        .at(-1).params;
      if (existing) assert.equal(target.chatId, 'chat');
      else assert.equal(target.projectId, 'p1');
      mic.events.get('pagehide')!();
      await tick();
    }
  });
}
