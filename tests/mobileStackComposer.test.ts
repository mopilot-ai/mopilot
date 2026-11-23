// Mobile Remote end to end: the composer's / and @ menus. A phone reads the commands and the chats and files its Mac lists, only for a chat it follows, and sends a skill beside a message, also one typed while the Mac is away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until, client, phoneMenu, type Relay } from './support/mobileStack.ts';
import { fakeSafe } from './support/remoteKit.ts';

const COMMANDS = [
  { name: 'review', description: 'Review the changes', hint: '[focus]', kind: 'command', as: 'text' },
  { name: 'pdf', description: 'Read PDF files', hint: '', kind: 'skill', as: 'skill' },
];

async function online(relay: Relay, o: Parameters<typeof startMac>[1] = {}) {
  const mac = await startMac(relay, o);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  mac.known.add('c1');
  return { mac, phone, request: client.ownedRequest(phone.runtime) };
}
const sent = (mac: any) => mac.calls.filter((c: any[]) => c[0] === 'send').map((c: any[]) => c[1]);

test('a phone reads the commands and skills of a chat and the chats and files an @ would list, the second only while it follows the chat', async () => {
  const relay = await startRelay();
  const lists = {
    chats: [{ id: 'c2', title: 'Kyoto trip' }],
    files: [
      { path: 'src/price.ts', name: 'price.ts', directory: false },
      { path: 'src', name: 'src', directory: true },
    ],
  };
  const { mac, phone, request } = await online(relay, {
    ops: { commands: async (p: any) => (p.chatId === 'c1' ? { commands: COMMANDS } : { commands: [] }), mentionsList: async () => lists },
  });
  assert.deepEqual(await phoneMenu.menusOffered(request), { commands: true, mentions: true });
  const commands = await phoneMenu.loadCommands(request, 'c1');
  assert.deepEqual(
    commands.map((c: any) => [c.name, c.as, c.skill]),
    [
      ['review', 'text', false],
      ['pdf', 'skill', true],
    ],
  );
  await assert.rejects(phoneMenu.loadMentions(request, 'c1', 'pr'), /Follow this chat/);
  await phone.ask('chat.follow', { chatId: 'c1' });
  const mentions = await phoneMenu.loadMentions(request, 'c1', 'pr');
  assert.deepEqual(
    mentions.map((m: any) => (m.kind === 'chat' ? `chat:${m.title}` : `${m.directory ? 'dir' : 'file'}:${m.path}`)),
    ['chat:Kyoto trip', 'file:src/price.ts', 'dir:src'],
  );
  await assert.rejects(phoneMenu.loadMentions(request, 'c2', 'pr'), /Follow this chat/, 'only the chat that is open');
  mac.known.add('c2');
  // what the picks write goes to the Mac as the message's text, and the skill beside it
  const popup = phoneMenu.popupAt('read @pr', 8, [])!;
  const text = phoneMenu.pickMention('read @pr', popup, 8, mentions[1]).text;
  phone.runtime.send('c1', text);
  await until(() => sent(mac).length === 1, 'the message');
  assert.equal(sent(mac)[0].text, 'read @src/price.ts', 'the Mac trims the message, as for any send');
});

test('a skill rides beside the message, and one typed while the Mac is away waits with it and goes once', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone } = await online(relay, { safe });
  phone.runtime.send('c1', 'summarize it', [], ['pdf']);
  await until(() => sent(mac).length === 1 && phone.snap().outbox.length === 0, 'the live message to be accepted');
  assert.deepEqual(sent(mac)[0].skills, ['pdf']);
  assert.equal(sent(mac)[0].text, 'summarize it');
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === phone.snap().pairs[0].pairId, 'the phone to wait for the Mac');
  phone.runtime.send('c1', 'and again', [], ['pdf', 'frontend-design']);
  assert.deepEqual(phone.snap().outbox[0].skills, ['pdf', 'frontend-design']);
  // kept on the phone with the message, sealed in its vault
  const saved = async () => (await phone.vault().getOutbox())?.items.find((i: any) => i.text === 'and again')?.skills;
  await until(async () => (await saved()) !== undefined, 'the message to be saved');
  assert.deepEqual(await saved(), ['pdf', 'frontend-design']);
  const again = await startMac(relay, { userData: mac.userData, safe });
  again.known.add('c1');
  await until(() => phone.snap().outbox.length === 0 && sent(again).length === 1, 'the queued message');
  assert.deepEqual(sent(again)[0].skills, ['pdf', 'frontend-design']);
  phone.runtime.send('c1', 'no skill');
  await until(() => sent(again).length === 2, 'a message without a skill');
  assert.equal('skills' in sent(again)[1] && sent(again)[1].skills.length > 0, false);
});

test('a Mac that does not offer a menu is not asked for it', async () => {
  const relay = await startRelay();
  const { phone, request } = await online(relay, {
    policy: () => ({ allow: (_pair: string, method: string) => method !== 'mentions.list' }),
  });
  assert.deepEqual(await phoneMenu.menusOffered(request), { commands: true, mentions: false });
  assert.equal(phone.snap().phase, 'online');
});
