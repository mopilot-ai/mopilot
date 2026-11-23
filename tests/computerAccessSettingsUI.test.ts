// Settings → Computer access (#1364, src/components/pages/settings/ComputerAccess.tsx, src/lib/computerAccess.ts): off
// until turned on, a pairing offer with its countdown, a device waiting with the code to compare and the scopes to
// give, paired devices (scopes, only-this-Mac approvals, Remove), remote sessions with Stop, other computers (Connect
// shows the code, the outcome arrives later, Forget), the access log, Reset when the settings can't be read, and a
// failed read with Retry. Main is the settings harness's fake native.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  calls,
  responses,
  resetCtl,
  defaultState,
  useStore,
  render,
  click,
  text,
  button,
  buttons,
  row,
  flush,
  setValue,
  toggle,
} from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');
const lib = await import('../src/lib/computerAccess.ts');
const { useSessions } = await import('../src/store/session/useSession.ts');

const host = (o: any = {}) => ({
  available: true,
  problem: null,
  enabled: false,
  blocked: false,
  lan: false,
  listening: null,
  pairing: null,
  request: null,
  devices: [],
  active: [],
  ...o,
});
const device = (o: any = {}) => ({
  id: 'd1',
  name: 'Laptop',
  fingerprint: 'abcdef0123456789abcdef0123456789',
  scopes: { browser: true, chrome: false, apps: false, files: false },
  pairedAt: 1,
  lastSeen: 2,
  hostOnlyApprovals: false,
  expired: false,
  online: true,
  ...o,
});
let changed: (() => void) | null = null;
let paired: ((r: any) => void) | null = null;
const toasts = () => calls.filter((c) => c[0] === 'toast').map((c) => c[1]);
const of = (name: string) => calls.filter((c) => c[0] === `computerAccess.${name}`).map((c) => c.slice(1));
const page = async () => {
  useStore.setState({ route: { name: 'settings' } });
  const v = await render(h(Settings, { section: 'computer-access' }));
  await flush();
  return v;
};

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
  changed = null;
  paired = null;
  responses['computerAccess.state'] = { host: host(), computers: [] };
  responses['computerAccess.log'] = [];
  responses['computerAccess.onChanged'] = (cb: () => void) => ((changed = cb), () => {});
  responses['computerAccess.onPaired'] = (cb: (r: any) => void) => ((paired = cb), () => {});
});

test('off until turned on: the switch writes, the page reads again, and nothing else is offered until it listens', async () => {
  const v = await page();
  const root = v.host;
  assert.match(text(row(root, 'Let paired devices use this Mac')), /Off\. No other computer can use this Mac\./);
  assert.equal(button(root, 'Pair a device').disabled, true);
  assert.equal(row(root, 'Allow computers on this network').querySelector('[role=switch]')!.hasAttribute('disabled'), true);
  assert.match(text(root), /Nothing yet\./);
  responses['computerAccess.state'] = { host: host({ enabled: true, listening: { address: '127.0.0.1', port: 47616 } }), computers: [] };
  await toggle(root, 'Let paired devices use this Mac');
  await flush();
  assert.deepEqual(of('setEnabled'), [[true]]);
  assert.match(text(row(root, 'Let paired devices use this Mac')), /On\. Paired devices reach this Mac at 127\.0\.0\.1:47616\./);
  await toggle(root, 'Allow computers on this network');
  await flush();
  assert.deepEqual(of('setLan'), [[true]]);
  // and off again: the kill switch
  responses['computerAccess.state'] = { host: host(), computers: [] };
  await toggle(root, 'Let paired devices use this Mac');
  await flush();
  assert.deepEqual(of('setEnabled'), [[true], [false]]);
  await v.unmount();
});

test('blocked by MoPilot, no Keychain, or settings that cannot be read: the page says so, and Reset starts over', async () => {
  responses['computerAccess.state'] = { host: host({ blocked: true }), computers: [] };
  let v = await page();
  assert.match(text(v.host), /MoPilot has turned Computer access off for now\./);
  assert.equal(row(v.host, 'Let paired devices use this Mac').querySelector('[role=switch]')!.hasAttribute('disabled'), true);
  responses['computerAccess.state'] = { host: host({ available: false }), computers: [] };
  v = await page();
  assert.match(text(v.host), /can't keep the access keys in the Keychain/);
  responses['computerAccess.state'] = {
    host: host({ problem: 'The computer access settings could not be read on this Mac' }),
    computers: [],
  };
  v = await page();
  assert.match(text(row(v.host, 'Computer access settings can')), /Reset removes every paired device/);
  await click(button(v.host, 'Reset'));
  assert.equal(of('reset').length, 1);
});

test('pairing: the offer with its countdown and Copy, a device waiting with its code and scopes, Allow and Deny', async () => {
  responses['computerAccess.state'] = { host: host({ enabled: true, listening: { address: '127.0.0.1', port: 47616 } }), computers: [] };
  const offer = { text: 'mopilot-access:1:127.0.0.1:47616:abc:def', expiresAt: Date.now() + 125_000 };
  responses['computerAccess.startPairing'] = offer;
  const v = await page();
  const root = v.host;
  responses['computerAccess.state'] = {
    host: host({ enabled: true, listening: { address: '127.0.0.1', port: 47616 }, pairing: { expiresAt: offer.expiresAt } }),
    computers: [],
  };
  await click(button(root, 'Pair a device'));
  await flush();
  assert.equal(text(root.querySelector('[data-testid=access-offer]')), offer.text);
  assert.match(text(row(root, 'Pair a device')), /It works once, for 2:0[45]\./);
  await flush(1100);
  await click(button(root, 'Copy'));
  assert.ok(calls.some((c) => c[0] === 'clipboard.write' && c[1] === offer.text));
  // Cancel withdraws the offer; a new one is shown again
  await click(button(row(root, 'Pair a device'), 'Cancel'));
  assert.equal(of('cancelPairing').length, 1);
  assert.equal(root.querySelector('[data-testid=access-offer]'), null);
  await click(button(root, 'Pair a device'));
  await flush();
  // a device proved the offer and waits for the person
  responses['computerAccess.state'] = {
    host: host({
      enabled: true,
      listening: { address: '127.0.0.1', port: 47616 },
      pairing: { expiresAt: offer.expiresAt },
      request: { name: 'Laptop', code: '123 456' },
    }),
    computers: [],
  };
  changed!();
  await flush();
  const req = root.querySelector('[data-testid=access-request]')!;
  assert.equal(text(req.querySelector('.access-request-title')), 'Laptop wants to use this Mac');
  assert.equal(text(req.querySelector('.access-request-code')), '123 456');
  assert.match(text(req), /Allow only if the other computer shows the same code/);
  const apps = [...req.querySelectorAll('label')].find((l) => text(l) === 'Apps')!.querySelector('input')!;
  await click(apps);
  await click(button(req as HTMLElement, 'Allow'));
  assert.deepEqual(of('answerPairing'), [[true, { browser: true, chrome: false, apps: true, files: false }]]);
  // the next device asking starts from the built-in browser alone
  responses['computerAccess.state'] = {
    host: host({
      enabled: true,
      listening: { address: '127.0.0.1', port: 47616 },
      pairing: { expiresAt: offer.expiresAt },
      request: { name: 'Tablet', code: '222 333' },
    }),
    computers: [],
  };
  changed!();
  await flush();
  const next = root.querySelector('[data-testid=access-request]')!;
  assert.equal(
    ([...next.querySelectorAll('label')].find((l) => text(l) === 'Apps')!.querySelector('input') as HTMLInputElement).checked,
    false,
  );
  await click(button(root.querySelector('[data-testid=access-request]') as HTMLElement, 'Deny'));
  assert.deepEqual(of('answerPairing').at(-1), [false]);
});

test('devices: scopes, only this Mac approves, Remove; sessions using this Mac with Stop; the access log', async () => {
  responses['computerAccess.state'] = {
    host: host({
      enabled: true,
      listening: { address: '127.0.0.1', port: 47616 },
      devices: [
        device(),
        device({ id: 'd3', name: 'Mini', online: false }),
        device({
          id: 'd2',
          name: 'Old Mac',
          online: false,
          expired: true,
          scopes: { browser: false, chrome: false, apps: false, files: false },
        }),
      ],
      active: [{ id: 'o1', device: 'd1', deviceName: 'Laptop', chat: 'c', harness: 'claude' }],
    }),
    computers: [],
  };
  responses['computerAccess.log'] = [
    { t: '2026-10-18T10:00:00.000Z', event: 'call', device: 'd1', deviceName: 'Laptop', tool: 'browser_navigate', outcome: 'ok', ms: 120 },
    { t: '2026-10-18T09:59:00.000Z', event: 'off' },
  ];
  const v = await page();
  const root = v.host;
  const [laptop, mini, old] = [...root.querySelectorAll('[data-testid=access-device]')] as HTMLElement[];
  assert.match(text(mini), /Not connected · Built-in browser/);
  assert.match(text(laptop), /Connected · Built-in browser · key abcdef01/);
  assert.match(text(old), /Unused for 30 days: pair it again · Nothing allowed/);
  const chrome = [...laptop.querySelectorAll('label')].find((l) => text(l) === 'Your Chrome')!.querySelector('input')!;
  await click(chrome);
  assert.deepEqual(of('setDevice')[0], ['d1', { scopes: { browser: true, chrome: true, apps: false, files: false } }]);
  const only = [...laptop.querySelectorAll('label')].find((l) => /Only this Mac/.test(text(l)))!.querySelector('input')!;
  await click(only);
  assert.deepEqual(of('setDevice')[1], ['d1', { hostOnlyApprovals: true }]);
  await click(button(laptop, 'Remove'));
  assert.deepEqual(of('revoke'), [['d1']]);
  assert.match(text(row(root, 'Laptop')), /Built-in browser/);
  const using = [...root.querySelectorAll('.settings-group')].find((g) => /Using this Mac now/.test(text(g)))!;
  assert.match(text(using), /A claude chat on Laptop/);
  await click(button(using as HTMLElement, 'Stop'));
  assert.deepEqual(of('stop'), [['o1']]);
  // a card that session raised here: answered on this Mac too
  await (async () => {
    const { act } = await import('react');
    await act(async () =>
      useSessions.setState({
        sessions: {
          o1: {
            approvals: [
              {
                id: 'sage-browserOrigin-1',
                method: 'sage/browserOrigin',
                params: { kind: 'browserOrigin', origin: 'https://shop.example', level: 'write' },
              },
              { id: 'sage-visionConsent-2', method: 'sage/visionConsent', params: { kind: 'visionConsent' } },
              { id: 'item-3', method: 'item/commandExecution/requestApproval', params: {} },
            ],
          } as any,
        },
      }),
    );
  })();
  const cards = [...root.querySelectorAll('[data-testid=access-card]')] as HTMLElement[];
  assert.equal(cards.length, 2);
  assert.match(text(cards[0]), /Use https:\/\/shop\.example in the built-in browser \(read and write\)/);
  await click(button(cards[0], 'Allow'));
  assert.deepEqual(calls.filter((c) => c[0] === 'computer.answer').at(-1), [
    'computer.answer',
    'sage-browserOrigin-1',
    { decision: 'allow', scope: 'once', level: 'write' },
  ]);
  // a card only its device can show: Deny only
  assert.equal(buttons(cards[1], 'Allow').length, 0);
  await click(button(cards[1], 'Deny'));
  assert.deepEqual(calls.filter((c) => c[0] === 'computer.answer').at(-1), [
    'computer.answer',
    'sage-visionConsent-2',
    { decision: 'deny' },
  ]);
  const log = root.querySelector('[data-testid=access-log]')!;
  assert.match(text(log), /· Laptop used browser_navigate \(ok, 120 ms\)/);
  assert.match(text(log), /· Computer access went off/);
});

test('other computers: Connect shows the code to compare, the outcome arrives later, and Forget', async () => {
  responses['computerAccess.state'] = {
    host: host(),
    computers: [
      { id: 'h1', name: 'Studio', address: '127.0.0.1', port: 47616, pairedAt: 1, connected: true },
      { id: 'h2', name: 'Office', address: '192.168.1.9', port: 47616, pairedAt: 1, connected: false },
    ],
  };
  responses['computerAccess.pair'] = { code: '654 321' };
  const v = await page();
  const root = v.host;
  assert.match(text(row(root, 'Studio')), /Connected · 127\.0\.0\.1:47616/);
  assert.match(text(row(root, 'Office')), /Not connected · 192\.168\.1\.9:47616/);
  const input = root.querySelector('input[aria-label^="Pairing code"]')!;
  assert.equal(button(root, 'Connect').disabled, true);
  await setValue(input, '  mopilot-access:1:x  ');
  await click(button(root, 'Connect'));
  await flush();
  assert.deepEqual(of('pair'), [['mopilot-access:1:x']]);
  assert.equal(text(root.querySelector('[data-testid=access-pairing-code] .access-request-code')), '654 321');
  assert.match(text(root.querySelector('[data-testid=access-pairing-code]')), /Check that the other computer shows this code/);
  await (async () => paired!({ ok: true, name: 'Studio' }))();
  await flush();
  assert.equal(root.querySelector('[data-testid=access-pairing-code]'), null);
  assert.ok(toasts().includes('Paired with Studio'));
  // an outcome this window didn't start (another window paired) says nothing here
  const before = toasts().length;
  paired!({ ok: true, name: 'Elsewhere' });
  await flush();
  assert.equal(toasts().length, before);
  await setValue(input, 'mopilot-access:1:y');
  await click(button(root, 'Connect'));
  await flush();
  paired!({ ok: false, error: 'The person on this Mac did not allow pairing' });
  await flush();
  assert.ok(toasts().some((t: string) => /Pairing didn't finish: The person/.test(t)));
  await click(button(row(root, 'Studio'), 'Forget'));
  assert.deepEqual(of('forget'), [['h1']]);
  // a failed action says what failed
  responses['computerAccess.forget'] = () => Promise.reject(new Error('disk full'));
  await click(button(row(root, 'Studio'), 'Forget'));
  await flush();
  assert.ok(toasts().some((t: string) => /Couldn't forget that computer: disk full/.test(t)));
});

test("a read that fails says so with Retry; a read that arrives late doesn't replace a newer one; starting up says so", async () => {
  responses['computerAccess.state'] = () => Promise.reject(new Error('IPC down'));
  const v = await page();
  assert.match(text(row(v.host, "Couldn't read Computer access")), /IPC down/);
  responses['computerAccess.state'] = { host: host(), computers: [] };
  await click(button(v.host, 'Retry'));
  await flush();
  assert.ok(row(v.host, 'Let paired devices use this Mac'));
  // an older read finishing after a newer one is dropped
  let slow: (v: any) => void = () => {};
  responses['computerAccess.state'] = () => new Promise((r) => (slow = r));
  changed!();
  responses['computerAccess.state'] = { host: host({ enabled: true, listening: { address: '127.0.0.1', port: 1 } }), computers: [] };
  changed!();
  await flush();
  slow({ host: host(), computers: [] });
  await flush();
  assert.match(text(row(v.host, 'Let paired devices use this Mac')), /On\./);
  // a failure after a good read keeps the page
  responses['computerAccess.state'] = () => Promise.reject(new Error('later'));
  changed!();
  await flush();
  assert.ok(row(v.host, 'Let paired devices use this Mac'));
  // main still starting: no host yet
  responses['computerAccess.state'] = { host: null, computers: [] };
  const w = await page();
  assert.match(text(w.host), /Starting…/);
});

test('wording: scopes in a line, the time left, and every access log event as a sentence', () => {
  assert.equal(lib.scopeLabels({ browser: true, chrome: true, apps: true, files: false }), 'Built-in browser, Your Chrome, Apps');
  assert.equal(lib.scopeLabels({ browser: false, chrome: false, apps: false, files: true }), 'Nothing allowed');
  assert.equal(lib.timeLeft(10_000 + 65_000, 10_000), '1:05');
  assert.equal(lib.timeLeft(0, 10_000), '0:00');
  const t = '2026-10-18T10:00:00.000Z';
  for (const event of ['pairing', 'paired', 'denied', 'connected', 'disconnected', 'refused', 'revoked', 'stop'] as const)
    assert.match(
      lib.accessLogText({ t, event, deviceName: 'Laptop' }),
      new RegExp(`Laptop ${lib.accessLogText({ t, event }).split('A device ')[1]}`),
    );
  assert.match(
    lib.accessLogText({ t, event: 'refused', device: 'd1', tool: 'desktop_type', code: 'not_allowed' }),
    /d1 was refused desktop_type \(not_allowed\)/,
  );
  assert.match(lib.accessLogText({ t, event: 'call', deviceName: 'L', tool: 'x', outcome: 'error', code: 'error' }), /L used x \(error\)$/);
});

test('remote cards in a line, and what Allow on this Mac answers for each', () => {
  assert.match(lib.remoteCardText({ kind: 'browserOrigin', origin: 'https://a.example', level: 'read' }), /\(read only\)$/);
  assert.equal(lib.remoteCardText({ kind: 'browserOrigin' }), 'Use a site in the built-in browser (read only)');
  assert.equal(
    lib.remoteCardText({ kind: 'computerConfirm', verb: 'make a purchase', summary: 'left click "Place order"' }),
    'Make a purchase: left click "Place order"',
  );
  assert.equal(lib.remoteCardText({ kind: 'computerConfirm' }), 'Do something that can’t be undone');
  assert.equal(lib.remoteCardText({ kind: 'computerAccess', app: { bundleId: 'n', name: 'Notes' } }), 'Control Notes');
  assert.equal(lib.remoteCardText({ kind: 'computerAccess' }), 'Control an app');
  assert.equal(lib.remoteCardText({ kind: 'computerAccessSet', apps: [{ bundleId: 'n', name: 'Notes' } as any] }), 'Use Notes');
  assert.equal(lib.remoteCardText({ kind: 'computerAccessSet' }), 'Use apps');
  assert.equal(lib.remoteCardText({ kind: 'computerTakeover' }), 'Take over the screen');
  assert.equal(lib.remoteCardText(null), 'Something only its own device can show');
  assert.deepEqual(lib.remoteCardAllow({ kind: 'computerAccess', level: 'click' }), { decision: 'allow', scope: 'once', level: 'click' });
  assert.deepEqual(lib.remoteCardAllow({ kind: 'computerTakeover' }), { decision: 'allow' });
  assert.deepEqual(lib.remoteCardAllow({ kind: 'computerConfirm' }), { decision: 'allow' });
  assert.deepEqual(lib.remoteCardAllow({ kind: 'browserOrigin', level: 'read' }), { decision: 'allow', scope: 'once', level: 'read' });
  assert.deepEqual(lib.remoteCardAllow({ kind: 'computerAccessSet', apps: [{ bundleId: 'n', name: 'Notes' } as any] }), {
    decision: 'allow',
    apps: ['n'],
  });
  assert.deepEqual(lib.remoteCardAllow({ kind: 'computerAccessSet' }), { decision: 'allow', apps: [] });
  assert.equal(lib.remoteCardAllow(undefined), null);
});

test('pairing: a code past its time leaves the page and says it expired; Pair a device makes a new one', async () => {
  responses['computerAccess.state'] = { host: host({ enabled: true, listening: { address: '127.0.0.1', port: 47616 } }), computers: [] };
  const offer = { text: 'mopilot-access:1:127.0.0.1:47616:abc:old', expiresAt: Date.now() + 1500 };
  responses['computerAccess.startPairing'] = offer;
  const v = await page();
  const root = v.host;
  responses['computerAccess.state'] = {
    host: host({ enabled: true, listening: { address: '127.0.0.1', port: 47616 }, pairing: { expiresAt: offer.expiresAt } }),
    computers: [],
  };
  await click(button(root, 'Pair a device'));
  await flush();
  assert.equal(text(root.querySelector('[data-testid=access-offer]')), offer.text);
  await flush(2200);
  assert.equal(root.querySelector('[data-testid=access-offer]'), null);
  assert.match(text(row(root, 'Pair a device')), /That code expired\. Make a new one\./);
  responses['computerAccess.startPairing'] = { text: 'mopilot-access:1:127.0.0.1:47616:abc:new', expiresAt: Date.now() + 300_000 };
  await click(button(row(root, 'Pair a device'), 'Pair a device'));
  await flush();
  assert.equal(text(root.querySelector('[data-testid=access-offer]')), 'mopilot-access:1:127.0.0.1:47616:abc:new');
  await v.unmount();
});

test('pairing with network access off: the row says other computers need it; changing it drops a code made for the old address', async () => {
  const listening = { address: '127.0.0.1', port: 47616 };
  responses['computerAccess.state'] = { host: host({ enabled: true, listening }), computers: [] };
  const offer = { text: 'mopilot-access:1:127.0.0.1:47616:abc:def', expiresAt: Date.now() + 300_000 };
  responses['computerAccess.startPairing'] = offer;
  const v = await page();
  const root = v.host;
  assert.match(text(row(root, 'Pair a device')), /Other computers need Allow computers on this network\./);
  responses['computerAccess.state'] = { host: host({ enabled: true, listening, pairing: { expiresAt: offer.expiresAt } }), computers: [] };
  await click(button(root, 'Pair a device'));
  await flush();
  assert.equal(text(root.querySelector('[data-testid=access-offer]')), offer.text);
  responses['computerAccess.state'] = { host: host({ enabled: true, lan: true, listening }), computers: [] };
  await toggle(root, 'Allow computers on this network');
  await flush();
  assert.equal(of('cancelPairing').length, 1, 'the code for 127.0.0.1 is withdrawn');
  assert.deepEqual(of('setLan').at(-1), [true]);
  assert.equal(root.querySelector('[data-testid=access-offer]'), null);
  assert.doesNotMatch(text(row(root, 'Pair a device')), /Other computers need/);
  // no code shown: the switch changes nothing else
  await toggle(root, 'Allow computers on this network');
  await flush();
  assert.equal(of('cancelPairing').length, 1);
  await v.unmount();
});
