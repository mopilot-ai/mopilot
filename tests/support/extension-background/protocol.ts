// Extension protocol unit cases using shared fake Chrome, socket, timer, and page fixtures.
import { test, assert, webcrypto, protocol, main, SECRET } from './fixture.ts';

export function registerProtocol() {
  test('pairing codes: the port and the secret, read back; anything else is not a code', () => {
    const code = protocol.pairingCode(47615, SECRET);
    assert.equal(code, main.pairingCode({ port: 47615, secret: SECRET }), 'main writes the code the extension reads');
    assert.deepEqual(protocol.parsePairingCode(` ${code} `), { port: 47615, secret: SECRET });
    assert.equal(protocol.parsePairingCode(undefined), null);
    assert.equal(protocol.parsePairingCode('mopilot-chrome:1:80:' + SECRET), null, 'a privileged port');
    assert.equal(protocol.parsePairingCode('mopilot-chrome:1:99999:' + SECRET), null);
    assert.equal(protocol.parsePairingCode('mopilot-chrome:2:47615:' + SECRET), null);
    // the one-time claim code the pairing page is opened with
    const token = 't'.repeat(32);
    assert.deepEqual(protocol.parseClaimCode(`mopilot-claim:1:47615:${token}`), { port: 47615, token });
    assert.equal(protocol.parseClaimCode(`mopilot-claim:1:80:${token}`), null);
    assert.equal(protocol.parseClaimCode(code), null);
    assert.equal(protocol.parseClaimCode(null), null);
  });

  test('handshake proofs: the extension’s and main’s agree for each role, and differ by role and nonce order', async () => {
    for (const role of ['extension', 'app'] as const) {
      assert.equal(await protocol.proof(webcrypto, SECRET, role, 'a1', 'b2'), main.proofOf(SECRET, role, 'a1', 'b2'));
    }
    assert.notEqual(main.proofOf(SECRET, 'app', 'a', 'b'), main.proofOf(SECRET, 'extension', 'a', 'b'));
    assert.notEqual(main.proofOf(SECRET, 'app', 'a', 'b'), main.proofOf(SECRET, 'app', 'b', 'a'));
    assert.match(protocol.nonce(webcrypto), /^[0-9a-f]{32}$/);
    assert.equal(protocol.sameText('abc', 'abc'), true);
    assert.equal(protocol.sameText('abc', 'abd'), false);
    assert.equal(protocol.sameText('abc', 'ab'), false);
    assert.equal(protocol.sameText(1, 'a'), false);
  });
}
