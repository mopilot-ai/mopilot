// A MoMo voice note through the dev host with the real phone client: heard (the fake sentence), failing, silent, an older Mac without the method, and MoMo off.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPhone, until } from './support/mobileStack.ts';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';
import { VOICE_TEXT } from '../scripts/mobile-dev-host/fakeMomo.mjs';
import './support/phone/register.ts';
// the phone's client loaded by path, with the phone's own module registry, as the other phone tests do
const clientPath = '../mobile/src/remote/client';
const { ownedRequest, transcribe } = await import(clientPath);

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-voice-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('a MoMo voice note is heard, fails, comes back silent, and is hidden as an older Mac would, then MoMo off drops it', async () => {
  const host = await startHost({
    dir: path.join(scratch, 'one'),
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: () => undefined,
    sleep: async () => undefined,
  });
  after(() => host.stop());
  const phone = await startPhone(
    {
      wsUrl: host.relayUrl,
      keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
    } as any,
    { userId: 'dev-user', relayUrl: host.relayUrl },
  );
  await phone.pair((await host.pair()).qr);
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);

  await host.scenarios.run('momo', ['on']);
  const listed = async () => (await phone.ask('machine.hello')).capabilities.methods.includes('momo.chat.transcribe');
  const note = (method?: string) =>
    transcribe(
      ownedRequest(phone.runtime),
      { base64: Buffer.from('RIFFxxxxWAVE').toString('base64'), mime: 'audio/wav' },
      null,
      new AbortController().signal,
      method,
    );
  assert.equal(await listed(), true);
  assert.equal((await note('momo.chat.transcribe')).text, VOICE_TEXT);
  await host.scenarios.run('momo-voice', ['fail']);
  await assert.rejects(note('momo.chat.transcribe'), /Speech services did not respond/);
  await host.scenarios.run('momo-voice', ['empty']);
  await assert.rejects(note('momo.chat.transcribe'), /No speech was heard/);
  // the coding chat's voice note is the fake app's own, whatever MoMo's is set to
  assert.match((await note()).text, /^Heard 12 bytes of audio\/wav: a WAV file\./);
  await host.scenarios.run('momo-voice', ['off']);
  assert.equal(await listed(), false);
  await assert.rejects(note('momo.chat.transcribe'));
  await host.scenarios.run('momo-voice');
  assert.equal(await listed(), true);
  await host.scenarios.run('momo', ['off']);
  assert.equal(await listed(), false);
});
