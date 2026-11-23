// Per-tab side-panel fixture with two native tabs and the authoritative panel page's storage owner.
import { panelPage } from './side-panel-page.ts';
import { bindingKey } from '../../electron/chrome-extension/src/panelState.mjs';
/** The side panel page opened for one tab (its address carries the tab id). */
export function tabPanel(o: { bound?: any; owner?: any } = {}) {
  const p = panelPage({
    reply: (m: any) => {
      if (m.type === 'tabChat') return { chat: o.owner ?? null };
      if (m.type !== 'panel') return { status: 'connected' };
      if (m.method === 'harnesses') return { status: 'connected', result: { harnesses: [{ id: 'claude', label: 'Claude Code' }] } };
      if (m.method === 'read') return { status: 'connected', result: { rows: [], turn: 'idle' } };
      if (m.method === 'start') return { status: 'connected', result: { chatId: 'chat-9' } };
      return { status: 'connected' };
    },
  });
  const [tab] = [...p.chrome.tabsById.values()];
  const other = p.chrome.addTab({ title: 'Other tab', url: 'https://other.example/' });
  if (o.bound) void p.chrome.storage.session.set({ [bindingKey(tab.id)]: o.bound });
  p.g.location = { search: `?tabId=${tab.id}` };
  return { ...p, tab, other };
}
export const reads = (p: any) =>
  p
    .sent()
    .filter((m: any) => m.method === 'read')
    .map((m: any) => m.params.chatId);
