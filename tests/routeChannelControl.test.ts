// A command's control (its abort and its upload's bytes) reaches the channel that runs it (electron/host/localHost.cjs routeChannel): an add's Cancel stops the ssh command under way and its progress bar moves with the bytes, which the route in front of the ssh channel used to drop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { routeChannel } = require('../electron/host/localHost.cjs');

test('the control of a command goes to the channel the address routes to, remote or local', async () => {
  const seen: any[][] = [];
  const channel =
    (name: string) =>
    async (...args: any[]) => (seen.push([name, ...args]), { code: 0, stdout: name, stderr: '' });
  const route = routeChannel(channel('remote'), channel('local'));
  const control = { signal: new AbortController().signal, onBytes: () => undefined };
  const input = Buffer.from('x');
  assert.equal((await route('me@box', 'uname -sm', input, control)).stdout, 'remote');
  assert.equal((await route('local:this-mac', 'uname -sm', undefined, control)).stdout, 'local');
  assert.deepEqual(
    seen.map(([name, , , , c]) => [name, c === control]),
    [
      ['remote', true],
      ['local', true],
    ],
  );
});
