// The Host's desktop on a real machine (G8 #3903): installs the Host with the app's own installer, gives it the CU helper, and drives `desktop.*` over its socket: capabilities.desktop read from the helper's grants, a lease, a screenshot and a click, a second chat refused, a resent call answered once, and the lease ending with its connection. Run on a disposable guest only: it acts on that guest's desktop, and its disconnect check ends every `nc -U` connection to the Host's socket in the guest, so never point it at a machine anyone else uses:
//   VMLOCK_VM=<vm> ~/bench/runner/vmlock.sh acquire <tag>; node bench/g8-host-desktop.mjs --vm <mopilot-*> --helper <path of "MoPilot.app" on the guest>
// The helper's macOS grants are the image's (provision them first); the run changes none.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelFor, realDeps, runSteps } from '../scripts/host-accept.mjs';
import { exitCode, formatReport } from '../scripts/host-accept/report.mjs';
import { STEPS, expect, restart, until } from '../scripts/host-accept/steps.mjs';
import { lineClient } from '../scripts/host-accept/wire.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {any} ctx */
const connect = (ctx) => lineClient(ctx.m.open(`nc -U '${ctx.state.socket}'`));

/** A paired connection that said hello. @param {any} ctx */
async function session(ctx) {
  const c = connect(ctx);
  await ctx.deps.authenticate((/** @type {string} */ m, /** @type {object} */ p) => c.request(m, p), ctx.state.identity);
  expect((await c.request('host.hello', ctx.deps.helloParams())).agreed, 'The Host and this run agree on no version.');
  return c;
}

/** @param {{ helper: string }} o */
export const desktopSteps = ({ helper }) => [
  ...STEPS.filter((s) => ['A1', 'A2', 'A3', 'A4', 'A5'].includes(s.id)),
  {
    id: 'D1',
    title: 'Give the Host its helper; capabilities.desktop reads true from the helper’s own grants (cu stays false)',
    async run(/** @type {any} */ ctx) {
      const dest = `${ctx.state.dataDir}/helper`;
      const r = await ctx.m.run(`rm -rf "${dest}" && mkdir -p "${dest}" && cp -R "${helper}" "${dest}/"`);
      expect(r.code === 0, `The helper could not be copied: ${r.stderr}`);
      await restart(ctx);
      const status = await until(
        async () => {
          const c = connect(ctx);
          try {
            const s = await c.request('status');
            return s.capabilities?.desktop === true ? s : null;
          } finally {
            c.close();
          }
        },
        { what: 'status to report capabilities.desktop', every: 1000 },
      );
      expect(status.capabilities.cu === false, 'capabilities.cu must stay false for a Host.');
      return `capabilities ${JSON.stringify(status.capabilities)}`;
    },
  },
  {
    id: 'D2',
    title: 'A lease, a screenshot and a click through the Host; a repeated call id acts once',
    async run(/** @type {any} */ ctx) {
      const c = await session(ctx);
      const at = { chatId: 'acp:fake:desktop-one', epoch: 1 };
      expect((await c.request('desktop.lease', { ...at, apps: '*' })).leased, 'The lease was not granted.');
      const t0 = Date.now();
      const shot = await c.request('desktop.call', {
        ...at,
        callId: 'shot-0001',
        method: 'screenshot',
        params: { maxSide: 1440, format: 'jpeg' },
      });
      const shotMs = Date.now() - t0;
      expect(shot.width > 0 && (shot.png || shot.jpeg), 'The screenshot carried no image.');
      const t1 = Date.now();
      await c.request('desktop.call', { ...at, callId: 'click-0001', method: 'input.move', params: { x: 600, y: 400 } });
      const moveMs = Date.now() - t1;
      const t2 = Date.now();
      const a = await c.request('desktop.call', { ...at, callId: 'cursor-0001', method: 'input.cursor', params: {} });
      const b = await c.request('desktop.call', { ...at, callId: 'cursor-0001', method: 'input.cursor', params: {} });
      expect(a != null && b != null, 'No answer for the cursor reads.');
      await c.request('desktop.release', at);
      c.close();
      return `screenshot ${shot.width}x${shot.height} in ${shotMs} ms, move in ${moveMs} ms, two reads in ${Date.now() - t2} ms`;
    },
  },
  {
    id: 'D3',
    title: 'A second chat is refused while one holds the desktop; closing the first connection lets go',
    async run(/** @type {any} */ ctx) {
      const one = await session(ctx);
      const two = await session(ctx);
      await one.request('desktop.lease', { chatId: 'acp:fake:desktop-one', epoch: 1, apps: '*' });
      let code = '';
      try {
        await two.request('desktop.lease', { chatId: 'acp:fake:desktop-two', epoch: 1, apps: '*' });
      } catch (e) {
        code = /** @type {any} */ (e).code;
      }
      expect(code === 'busy', `A second chat should be refused as busy, got "${code}".`);
      // closing the client of a `tart exec` leaves the guest's own `nc` running, so the connection stays open on the Host: the guest's connections are ended there, which is what a vanished client looks like to the Host
      one.close();
      two.close();
      await ctx.m.run("pkill -f 'nc -U .*mopilot-host/host.sock'; true");
      const three = await session(ctx);
      const leased = await until(
        async () =>
          (await three.request('desktop.lease', { chatId: 'acp:fake:desktop-two', epoch: 1, apps: '*' }).catch(() => null))?.leased,
        {
          what: 'the first connection’s lease to end',
          every: 500,
          ms: 20_000,
        },
      );
      expect(leased, 'The desktop was not let go with its connection.');
      await three.request('desktop.release', { chatId: 'acp:fake:desktop-two', epoch: 1 });
      three.close();
      return 'refused as busy, then granted after the first connection closed';
    },
  },
];

/** @param {string[]} argv */
export async function main(argv) {
  const get = (/** @type {string} */ flag) => argv[argv.indexOf(flag) + 1];
  const vm = get('--vm');
  const helper = get('--helper');
  if (!vm || !helper) throw new Error('usage: node bench/g8-host-desktop.mjs --vm <mopilot-*> --helper <MoPilot.app on the guest>');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-accept-desktop-'));
  const ctx = {
    m: channelFor(/** @type {any} */ ({ vm, ssh: '', sshArgs: [] })),
    deps: realDeps(),
    root: ROOT,
    outDir,
    target: vm,
    nonce: path.basename(outDir).slice(-6),
    state: {},
  };
  const rows = await runSteps({ steps: desktopSteps({ helper }), ctx });
  const report = formatReport({ target: vm, rows, platform: /** @type {any} */ (ctx.state).platform });
  process.stdout.write(`${report}\n`);
  fs.rmSync(outDir, { recursive: true, force: true });
  return exitCode(rows);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      process.stderr.write(`g8-host-desktop: ${e.message}\n`);
      process.exitCode = 2;
    },
  );
