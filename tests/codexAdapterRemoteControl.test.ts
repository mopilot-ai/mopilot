// Remote Control on the Codex adapter: a window asks for it by name (codex:api), the app-server's status notification keeps it current
// without becoming a chat's event, and the process's exit takes the link with it.
import { test, assert, setup } from './support/codex-adapter/fixture.ts';

const state = (status: string, environmentId: string | null = null) => ({ status, serverName: 'mac', installationId: 'i', environmentId });

test('a window reads the link once and turns it on ephemerally by name; the notification changes it and reaches no chat', async () => {
  const { a, server, events } = setup({
    'remoteControl/status/read': () => state('disabled'),
    'remoteControl/enable': () => state('connecting'),
    'remoteControl/disable': () => state('disabled'),
  });
  assert.equal((await a.api('remoteControlRead', [])).status, 'disabled');
  assert.equal((await a.api('remoteControlSet', [true])).status, 'connecting');
  const enable = server.sent.find((m: any) => m.method === 'remoteControl/enable');
  assert.deepEqual(enable.params, { ephemeral: true });
  server.notify('remoteControl/status/changed', state('connected', 'env1'));
  assert.deepEqual(await a.api('remoteControlRead', []), {
    status: 'connected',
    environmentId: 'env1',
    error: null,
    detail: null,
    retrying: false,
  });
  assert.equal(
    events.some((e: any) => e.e.kind === 'notification'),
    false,
  );
  // anything but a literal true is off
  await a.api('remoteControlSet', ['yes']);
  assert.ok(server.sent.some((m: any) => m.method === 'remoteControl/disable'));
});

test("the app-server's exit takes the link with it, and the next process is read afresh", async () => {
  const { a, server } = setup({
    'remoteControl/status/read': () => state('disabled'),
    'remoteControl/enable': () => state('connected', 'env1'),
  });
  assert.equal((await a.api('remoteControlSet', [true])).status, 'connected');
  server.emit({ kind: 'exit', code: 1, signal: null, stderr: '' });
  assert.deepEqual(a.remoteControl.snapshot(), { status: 'disabled', environmentId: null, error: null, detail: null, retrying: false });
  await a.connect();
  assert.equal((await a.api('remoteControlRead', [])).status, 'disabled');
});

test('a window reaches pairing, the devices and revoke by name, for the environment main knows', async () => {
  const { a, server } = setup({
    'remoteControl/enable': () => state('connected', 'env1'),
    'remoteControl/pairing/start': () => ({ pairingCode: 'p', manualPairingCode: 'ABCD-1234', environmentId: 'env1', expiresAt: 9 }),
    'remoteControl/pairing/status': () => ({ claimed: true }),
    'remoteControl/client/list': () => ({
      data: [{ clientId: 'a', displayName: 'Phone', platform: 'iOS', lastSeenAt: 1 }],
      nextCursor: null,
    }),
    'remoteControl/client/revoke': () => ({}),
  });
  await assert.rejects(a.api('remoteControlPairing', []), /Turn Remote Control on first/);
  await a.api('remoteControlSet', [true]);
  assert.deepEqual(await a.api('remoteControlPairing', []), { code: 'ABCD-1234', expiresAt: 9 });
  assert.equal(await a.api('remoteControlClaimed', ['ABCD-1234']), true);
  assert.equal((await a.api('remoteControlClients', []))[0].name, 'Phone');
  await a.api('remoteControlRevoke', ['a']);
  const revoke = server.sent.find((m: any) => m.method === 'remoteControl/client/revoke');
  // the environment is main's own, never a window's
  assert.deepEqual(revoke.params, { environmentId: 'env1', clientId: 'a' });
});

test("the app-server's stderr reaches the link: a remote-control warning becomes the failure's detail", async () => {
  const { a, server } = setup({ 'remoteControl/enable': () => state('connecting') });
  await a.api('remoteControlSet', [true]);
  server.notify('remoteControl/status/changed', state('errored'));
  server.stderr(' WARN codex_app_server_transport::transport::remote_control::websocket: relay said no\n');
  assert.equal(a.remoteControl.snapshot().detail, 'relay said no');
});
