// Exercise the real phone feed and saved Claude history in a serialized main-process callback.
export async function phoneLiveSteer(_electron: unknown, root: string) {
  const path = process.getBuiltinModule('path');
  const require = process.getBuiltinModule('module').createRequire(path.join(root, 'package.json'));
  const { openPhoneItems } = require(path.join(root, 'electron/app/chromePanelPhones.cjs'));
  const { openHistory, historyPage, releaseHistory } = require(path.join(root, 'electron/platform/claudeHistory.cjs'));
  const { recentRowsOf } = require(path.join(root, 'electron/capabilities/browser/chromePanelLive.cjs'));
  const events: any[] = [];
  let saved: any[] = [];
  const phone = openPhoneItems({
    service: () => ({ attached: true, onFeedEvent: (e: any) => events.push(e) }),
    chatOf: () => 'chat',
    rows: async () => saved,
  });
  const message = (msg: any) => phone.live('claude', { kind: 'message', key: 'claude:phone-repro', msg });
  const reply = (id: string, text: string) => ({ type: 'assistant', uuid: id, message: { id, content: [{ type: 'text', text }] } });
  const tool = (id: string, command: string) => ({
    type: 'assistant',
    uuid: id,
    message: { id, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
  const user = (uuid: string, text: string) => ({ type: 'user', uuid, message: { content: text } });
  phone.live('claude', { kind: 'turnStarting', key: 'claude:phone-repro', turnId: 'ct-a', clientId: 'a', text: 'A' });
  message(reply('t1', 'T1'));
  message(tool('s1', 'step one'));
  message(reply('t2', 'T2'));
  message(tool('s2', 'step two'));
  phone.live('claude', { kind: 'steered', key: 'claude:phone-repro', clientId: 'b', text: 'B' });
  message({ type: 'result', subtype: 'success' });
  message(reply('t3', 'T3'));
  message(tool('s3', 'step three'));
  phone.live('claude', { kind: 'steered', key: 'claude:phone-repro', clientId: 'c', text: 'C' });
  message({ type: 'result', subtype: 'success' });
  message(reply('t4', 'T4'));
  const live = await phone.items('chat', 50);
  const held = await openHistory([user('a', 'A'), reply('t1', 'T1'), tool('s1', 'step one'), reply('t2', 'T2')], 'chat', '/w', {
    key: 'claude:phone-repro',
  });
  try {
    const turns = JSON.parse(String((await historyPage(held)).page)).turns;
    saved = recentRowsOf(turns.map((turn: any) => ({ ...turn, sourceSession: 'claude:phone-repro' }))).rows;
  } finally {
    releaseHistory(held);
  }
  const caughtUp = await phone.items('chat', 50);
  phone.forget('chat');
  return { live, caughtUp, events };
}
