// Socket-free extension membership fixture with real Sessions and controlled Chrome API boundaries.
import { Sessions } from '../../electron/chrome-extension/src/sessions.mjs';
import { fakeChromeApi } from './chrome-extension-kit.ts';

export async function membershipExtension({ receipts = true, storage = true } = {}) {
  const chrome = fakeChromeApi();
  const sent: any[] = [];
  const errors: any[] = [];
  const sessions = new Sessions({
    chrome,
    send: (m: any) => sent.push(m),
    storage: storage ? chrome.storage.session : null,
    log: (...args: any[]) => errors.push(args),
  });
  await sessions.handle({ chat: 'a', method: 'session.open', params: [{ title: 'A' }] }, undefined, receipts);
  await sessions.handle({ chat: 'b', method: 'session.open', params: [{ title: 'B' }] }, undefined, receipts);
  let id = 1;
  const request = async (chat: string, method: string, params: any[] = [], membership?: unknown, turn = 0) => {
    let reply: any;
    await sessions.handle(
      { chat, method, params, membership, turn, id: id++ },
      (m: any) => {
        reply = m;
      },
      receipts,
    );
    return reply;
  };
  const create = async (chat = 'a') => {
    const r = await request(chat, 'chrome.tabs.create', [{}]);
    if (r.error) throw new Error(r.error.message);
    return r.result;
  };
  const move = (tabId: number, groupId: number) => {
    const tab = chrome.tabsById.get(tabId);
    tab.groupId = groupId;
    sessions.onTabUpdated(tabId, { groupId }, { ...tab });
  };
  return { chrome, sessions, sent, errors, request, create, move };
}
