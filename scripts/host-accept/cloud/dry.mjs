// The dry mode of the cloud acceptance run (`--cloud oci --dry`): only GET calls, to say whether the real run may start (the key, an empty compartment, the free shape, an image, a way in and out of the subnet), and what it would do cell by cell. It also says what the Host and launcher cannot do yet, so a cell that must fail is named before it costs a boot.
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS } from './limits.mjs';

/** Whether anything under host/ builds the idle stop: only then does a Host halt its own machine. @param {string} root */
export function idleStopWired(root) {
  /** @param {string} dir @returns {boolean} */
  const scan = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).some((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name !== 'node_modules' && scan(p);
      return /\.(?:mjs|cjs|js)$/.test(e.name) && e.name !== 'idleStop.mjs' && /\bcreateIdleStop\(/.test(fs.readFileSync(p, 'utf8'));
    });
  return scan(path.join(root, 'host'));
}

/** @param {string} id @param {string} title @param {(c: any) => Promise<string | { skip: string }>} run */
const step = (id, title, run) => ({ id, title, run });

/** The checks, as steps of the acceptance report. */
export function drySteps() {
  return [
    step('D1', 'the key is accepted (a signed read)', async ({ cloud: { readers, config } }) => {
      const regions = await readers.regions();
      if (!regions.includes(config.region)) throw new Error(`${config.region} is not among the ${regions.length} regions the key lists.`);
      return `${regions.length} regions listed, ${config.region} among them`;
    }),
    step('D2', 'the test compartment is empty and holds no disk', async ({ cloud }) => {
      const look = await cloud.readers.look();
      cloud.look = look;
      if (!look.empty) {
        const what = [...look.live.map((m) => `${m.name} ${m.state}`), ...look.volumes.map((v) => `disk ${v.gb} GB ${v.state}`)];
        throw new Error(`Not empty (${what.join(', ')}): a run would start over something it did not make.`);
      }
      return `${look.instances.length} instance(s) listed, none live; no disk; ${look.ads.length} availability domains (${look.volumeGb} GB used of the ${LIMITS.bootGb} GB the run may use)`;
    }),
    step('D3', `${LIMITS.shape} is offered in every availability domain`, async ({ cloud }) => {
      const ads = cloud.look?.ads ?? (await cloud.readers.domains());
      const seen = [];
      for (const ad of ads) seen.push(`${ad.split(':').pop()} ${(await cloud.readers.shapes(ad)).includes(LIMITS.shape) ? 'yes' : 'NO'}`);
      if (seen.some((s) => s.endsWith('NO'))) throw new Error(`The free shape is missing somewhere: ${seen.join(', ')}.`);
      return seen.join(', ');
    }),
    step('D4', 'an Ubuntu image for the free shape', async ({ cloud }) => {
      const image = await cloud.readers.image(LIMITS.shape);
      if (!image) throw new Error('No Ubuntu image is offered for that shape.');
      return `${image.name}`;
    }),
    step('D5', 'the subnet is public, with a route out, SSH in and egress', async ({ cloud: { readers, config } }) => {
      const s = await readers.subnet(config.subnetId);
      if (!s.isPublic) throw new Error('The subnet forbids public addresses: the machine could not be reached.');
      const lists = await Promise.all(s.securityListIds.map((id) => readers.securityList(id)));
      const sshIn = lists.some((l) => l.sshIn);
      const egress = lists.some((l) => l.egressOut);
      const route = s.routeTableId ? await readers.internetRoute(s.routeTableId) : false;
      const facts = `${s.cidr} ${s.state}; route to an internet gateway ${route ? 'yes' : 'NO'}; SSH in from anywhere ${sshIn ? 'yes' : 'NO'}; egress ${egress ? 'yes' : 'NO'}`;
      if (!route || !sshIn || !egress) throw new Error(facts);
      return facts;
    }),
    step('D6', 'the Host halts its own machine when idle (host/ builds createIdleStop)', async ({ root }) =>
      idleStopWired(root)
        ? 'wired'
        : {
            skip: 'NOT WIRED: nothing under host/ calls createIdleStop, so a real machine never stops itself; the idle-stop cell would fail by design, not by luck',
          },
    ),
  ];
}

/** The cells of the real run, as the plan the dry mode prints. @param {{ config: Record<string, string>, ads: string[] }} o */
export function planText({ config, ads }) {
  const order = ads.map((a) => a.split(':').pop()).join(' → ');
  return [
    '',
    `#### Plan for the real run (${config.region}, one machine: ${LIMITS.size}, ${LIMITS.bootGb} GB boot volume, availability domains tried in order ${order}, then stop)`,
    '',
    '| Cell | What the run does | Timing it reports |',
    '|---|---|---|',
    "| 1 | `launch` through the app's cloud launcher and OCI adapter; waits for RUNNING; installs the Host on the machine with the app's own installer over SSH and waits for it to answer | create→running, running→Host answering |",
    '| 2 | a chat on the fake ACP agent runs a turn on that Host (a real Claude Code or Codex turn needs a credential lent without a sign-in on the machine: not attempted) | turn first frame |',
    '| 3 | idle stop: the machine stops itself after the idle time and the provider reads STOPPED | idle→stopped |',
    '| 4 | wake: `cloudWake` asks the provider to START; when the Host answers, a message runs the turn | wake→first frame |',
    '| 5 | a day spend limit (`spend.dayUsd`, as in S10) holds the next send on that machine with `spend_limit`; raising it lets it go | none |',
    '| 6 | `destroy` (instance and boot volume), then a read of the compartment: no live instance, no disk | terminate→empty |',
    '',
    'Teardown runs in a `finally`: the machine is deleted by its id, and by its name if the id was never seen. Nothing outside the test compartment is read or written.',
  ].join('\n');
}
