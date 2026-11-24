// The steps of the acceptance run for the APP side of a remote Host: the app's own machine list, ssh tunnel, remote connection and outbox (electron/host), driven from plain Node against a Host on a real machine over real ssh. Same shape as ./host-accept/steps.mjs: a step takes the run's context and returns what it saw, or throws what was wrong.
import path from 'node:path';
import { cleanup as cleanMachine, expect, provideFakeAgent, restart, until } from '../host-accept/steps.mjs';
import { launchdStart, launchdStop } from '../../shared/host/launchd.mjs';
import { workFolder } from '../host-accept/workFolder.mjs';

/** The chat ids of this run (a Host keeps a chat's keys across runs). @param {any} ctx @param {string} name */
const chat = (ctx, name) => `acp:fake:${name}-${ctx.nonce}`;
const SOCKET_BYTES = 100;
/** The Host's process on the machine (a bracketed first letter keeps pgrep from matching the shell that runs the line). */
const SERVE = "pgrep -f '[m]opilot-host.mjs serve' | head -1";
/** A wait in milliseconds, scaled by the run's patience (1 on a real machine; a test shortens it). @param {any} ctx @param {number} ms */
const wait = (ctx, ms) => Math.round(ms * (ctx.patience ?? 1));

/** The assistant items and turn ends the Host's stream showed for a chat, in arrival order. @param {any} ctx @param {string} chatId */
const seen = (ctx, chatId) => ctx.state.items.get(chatId) ?? [];

/** Wait for a reply on the stream. @param {any} ctx @param {string} chatId @param {(item: any) => boolean} match @param {string} what @param {number} [ms] */
const reply = (ctx, chatId, match, what, ms = 40_000) =>
  until(async () => seen(ctx, chatId).find(match), { what, ms: wait(ctx, ms), every: 100 });

/** The remote Host of the machine, once it is online. @param {any} ctx @param {number} [ms] */
const online = (ctx, ms = 60_000) =>
  until(
    async () => {
      // connectedHost begins the connection when there is none and gives the Host once it answers
      return ctx.state.machines.connectedHost(ctx.state.id);
    },
    { what: 'the app’s connection to the Host to come up', ms: wait(ctx, ms), every: 250 },
  );

/** Follow a chat's stream and keep what it shows. @param {any} ctx @param {any} host @param {string} chatId */
async function follow(ctx, host, chatId) {
  if (!ctx.state.items.has(chatId)) ctx.state.items.set(chatId, []);
  const sub = await host.subscribe(chatId);
  ctx.state.revs.set(chatId, { rev: sub.snapshot.rev, generation: sub.generation });
  return sub;
}

/** @type {{ id: string, title: string, fatal?: boolean, run: (ctx: any) => Promise<string> }[]} */
export const STEPS = [
  {
    id: 'B1',
    title: 'The app can reach the machine over real ssh with a scratch key',
    fatal: true,
    async run(ctx) {
      const ip = ctx.deps.tartIp(ctx.target);
      const user = (await ctx.m.run('whoami')).stdout.trim();
      const node = (await ctx.m.run('uname -s; command -v node')).stdout.trim().split('\n');
      expect(user && ip, 'The machine has no address or user to reach.');
      ctx.state.os = node[0];
      ctx.state.nodePath = node[1];
      const key = path.join(ctx.dir, 'key');
      ctx.deps.keygen(key);
      const authorize = 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys';
      const added = await ctx.m.run(authorize, ctx.deps.readFile(`${key}.pub`));
      expect(added.code === 0, `The scratch key could not be authorized: ${added.stderr.trim()}`);
      ctx.state.dest = `${user}@${ip}`;
      ctx.state.sshArgs = [
        '-i',
        key,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        `UserKnownHostsFile=${ctx.dir}/known_hosts`,
        '-o',
        'StrictHostKeyChecking=accept-new',
      ];
      const r = ctx.deps.ssh(ctx.state.sshArgs, ctx.state.dest, 'echo reached');
      expect(r.trim() === 'reached', `ssh answered "${r.trim()}".`);
      return `${ctx.state.dest}, ${ctx.state.os}`;
    },
  },
  {
    id: 'B2',
    title: 'The app installs the Host over ssh and pairs (machines.add)',
    fatal: true,
    async run(ctx) {
      const { machines, pool, tunnels } = ctx.deps.makeMachines(ctx);
      ctx.state.machines = machines;
      ctx.state.pool = pool;
      ctx.state.tunnels = tunnels;
      const added = await machines.add(ctx.state.dest);
      expect(added.ok && added.paired, `Install ${added.ok ? 'worked' : 'failed'}, paired ${added.paired}: ${added.error}`);
      ctx.state.id = added.id;
      const row = machines.row(added.id);
      ctx.state.socket = row.socketPath;
      ctx.state.dataDir = path.posix.dirname(row.socketPath);
      return `machine ${added.id}; steps ${added.steps.map((s) => `${s.id}:${s.state}`).join(' ')}`;
    },
  },
  {
    id: 'B3',
    title: 'The registry shows the machine online with its harnesses and capabilities',
    async run(ctx) {
      const row = await until(async () => ctx.state.machines.list().machines.find((m) => m.id === ctx.state.id && m.status !== 'offline'), {
        what: 'the machine to be listed',
        ms: wait(ctx, 60_000),
      });
      const caps = ctx.state.machines.capabilities(ctx.state.id);
      return `${row.status}; capabilities ${JSON.stringify(caps)}`;
    },
  },
  {
    id: 'B4',
    title: 'With an app data folder too long for a socket, the tunnel keeps its socket in a short folder',
    async run(ctx) {
      expect(
        ctx.dir.length > SOCKET_BYTES - 21,
        `The data folder is only ${ctx.dir.length} bytes: this run does not exercise the fallback.`,
      );
      await online(ctx);
      const sockets = ctx.state.tunnels.map((t) => t.localSocket);
      expect(sockets.length > 0, 'No tunnel was made.');
      for (const s of sockets) expect(Buffer.byteLength(s) <= SOCKET_BYTES && !s.startsWith(ctx.dir), `The tunnel socket is ${s}.`);
      return `app folder ${ctx.dir.length} bytes; tunnel socket ${sockets[0]} (${Buffer.byteLength(sockets[0])} bytes)`;
    },
  },
  {
    id: 'B5',
    title: 'An ACP chat starts on the Host from the app and its reply arrives by subscription',
    async run(ctx) {
      await provideFakeAgent(ctx);
      await restart(ctx);
      const host = await online(ctx, 90_000);
      ctx.state.items = new Map();
      ctx.state.revs = new Map();
      host.events.onPatch(({ chatId, patch }) => seen(ctx, chatId).push(patch.item));
      host.events.onResync(({ chatId, snapshot }) => seen(ctx, chatId).push(...(snapshot.items ?? [])));
      const id = chat(ctx, 'one');
      await follow(ctx, host, id);
      const started = Date.now();
      await host.start(id, { harness: 'acp:fake', text: 'hello from the app', cwd: workFolder(ctx.state) });
      const got = await reply(ctx, id, (i) => i.t === 'assistant', 'the reply');
      expect(got.text === 'fake-acp: hello from the app', `The reply was "${got.text}".`);
      return `reply "${got.text}" ${Date.now() - started} ms after start`;
    },
  },
  {
    id: 'B6',
    title: 'Stop from the app ends a running turn as cancelled',
    async run(ctx) {
      const host = await online(ctx);
      const id = chat(ctx, 'stop');
      await follow(ctx, host, id);
      await host.start(id, { harness: 'acp:fake', text: 'SLOW please', cwd: workFolder(ctx.state) });
      await until(async () => (await ctx.m.run("pgrep -f '[f]ake-acp-agent'")).stdout.trim(), {
        what: 'the agent of the running turn',
        every: 200,
      });
      const started = Date.now();
      await host.stop(id);
      const end = await reply(ctx, id, (i) => i.t === 'assistant', 'the cancelled end');
      expect(end.stopReason === 'cancelled', `The turn ended with ${end.stopReason}.`);
      return `cancelled ${Date.now() - started} ms after Stop`;
    },
  },
  {
    id: 'B7',
    title: 'kill -9 of the Host mid-turn: the app’s connection drops, returns, and the turn reads as cancelled; the next message runs',
    async run(ctx) {
      const host = await online(ctx);
      const id = chat(ctx, 'crash');
      await follow(ctx, host, id);
      await host.start(id, { harness: 'acp:fake', text: 'SLOW please', cwd: workFolder(ctx.state) });
      await until(async () => (await ctx.m.run("pgrep -f '[f]ake-acp-agent'")).stdout.trim(), {
        what: 'the agent of the running turn',
        every: 200,
      });
      const states = [];
      const off = host.onState((s) => states.push(s));
      const killedAt = Date.now();
      await ctx.m.run("kill -9 $(pgrep -f '[m]opilot-host.mjs serve' | head -1)");
      await until(async () => states.length > 0, {
        what: 'the app to notice the Host is gone',
        ms: wait(ctx, 30_000),
        every: 100,
      });
      const noticed = Date.now() - killedAt;
      await online(ctx, 90_000);
      const back = Date.now() - killedAt;
      off();
      // the stream may resume by itself; if it does not within the wait, the app reads it again from the revision it reached
      let autoSub = false;
      try {
        await until(async () => seen(ctx, id).find((i) => i.t === 'assistant'), {
          what: 'the interrupted turn’s end',
          ms: wait(ctx, 5_000),
          every: 200,
        });
        autoSub = true;
      } catch (error) {
        ctx.state.notes = [...(ctx.state.notes ?? []), String(error.message)];
      }
      if (!autoSub) {
        const r = ctx.state.revs.get(id);
        const sub = await host.subscribe(id, r.rev, r.generation);
        seen(ctx, id).push(...sub.snapshot.items, ...(sub.patches ?? []).map((p) => p.patch.item));
      }
      const end = await reply(ctx, id, (i) => i.t === 'assistant', 'the interrupted turn’s end', 20_000);
      expect(end.stopReason === 'cancelled', `The interrupted turn ended with ${end.stopReason}.`);
      await host.send(id, { text: 'after the crash' });
      const next = await reply(ctx, id, (i) => i.t === 'assistant' && /after the crash/.test(i.text), 'the next reply');
      return `gone noticed in ${noticed} ms, back in ${back} ms (${autoSub ? 'stream resumed by itself' : 'resubscribed by rev'}); turn cancelled; next reply "${next.text}"`;
    },
  },
  {
    id: 'B8',
    title: 'A message sent while the Host is away waits as “Waiting for host” and is delivered when it is back',
    async run(ctx) {
      const id = chat(ctx, 'outbox');
      const { send, queue } = ctx.deps.makeSend(ctx, id);
      const stopCmd = ctx.state.os === 'Darwin' ? launchdStop() : 'systemctl --user stop mopilot-host';
      const startCmd =
        ctx.state.os === 'Darwin'
          ? launchdStart('"$HOME/Library/LaunchAgents/ai.mopilot.host.plist"')
          : 'systemctl --user start mopilot-host';
      await ctx.m.run(stopCmd);
      await until(async () => ctx.state.machines.hostFor(ctx.state.id)?.state() !== 'online', {
        what: 'the app to see the Host go',
        ms: wait(ctx, 60_000),
        every: 200,
      });
      send.begin(id, { harness: 'acp:fake' });
      const receipt = await send.send(id, { text: 'sent while away', cwd: workFolder(ctx.state) });
      expect(receipt.action === 'queued', `The send was ${receipt.action}, not queued.`);
      const waiting = queue(id).find((q) => q.waitingFor === 'host');
      expect(waiting, `The queue shows ${JSON.stringify(queue(id).map((q) => q.waitingFor))}, not "Waiting for host".`);
      const away = Date.now();
      await ctx.m.run(startCmd);
      const host = await online(ctx, 90_000);
      // what the app knows while it waits, for the failure message: the connection, the registry's row and the queue
      const why = () =>
        `connection ${ctx.state.machines.hostFor(ctx.state.id).state()}, registry row ${JSON.stringify(ctx.state.machines.row(ctx.state.id).status)}, queue ${JSON.stringify(queue(id).map((q) => q.waitingFor))}`;
      await until(async () => queue(id).length === 0, {
        what: 'the queued message to be delivered',
        ms: wait(ctx, 60_000),
        every: 250,
      }).catch((e) => {
        throw new Error(`${e.message} (${why()})`);
      });
      const items = [];
      host.events.onPatch(({ chatId, patch }) => chatId === id && items.push(patch.item));
      const sub = await host.subscribe(id);
      const text = [...sub.snapshot.items, ...items].filter((i) => i.t === 'assistant').map((i) => i.text);
      expect(
        text.some((t) => /sent while away/.test(t)),
        `The Host's reply to it was not seen (${JSON.stringify(text)}).`,
      );
      send.dispose();
      return `queued as "Waiting for host", delivered ${Date.now() - away} ms after the Host returned; reply "${text.at(-1)}"`;
    },
  },
  {
    id: 'B9',
    title: 'Update from the app (machines.updateHost) waits for a running turn, then the Host restarts into the build',
    async run(ctx) {
      const host = await online(ctx);
      const id = chat(ctx, 'update');
      await follow(ctx, host, id);
      await host.start(id, { harness: 'acp:fake', text: 'SLOW please', cwd: workFolder(ctx.state) });
      await until(async () => (await ctx.m.run("pgrep -f '[f]ake-acp-agent'")).stdout.trim(), {
        what: 'the agent of the running turn',
        every: 200,
      });
      const serving = async () => (await ctx.m.run(SERVE)).stdout.trim();
      const row = () => ctx.state.machines.list().machines.find((m) => m.id === ctx.state.id);
      const before = await serving();
      const plan = await ctx.state.machines.removePlan(ctx.state.id);
      expect(plan.busy === 'yes', `The Host said busy was "${plan.busy}" while a turn runs.`);
      const sentAt = Date.now();
      const sent = await ctx.state.machines.updateHost(ctx.state.id);
      const upload = Date.now() - sentAt;
      expect(row()?.update === 'waiting', `The row said "${row()?.update}" after the update was sent.`);
      expect((await serving()) === before, 'The Host restarted while a turn was running.');
      // the turn ends, the Host is idle, and it restarts into the staged build
      await host.stop(id);
      const stoppedAt = Date.now();
      const after = await until(async () => ((p) => (p && p !== before ? p : null))(await serving()), {
        what: 'the Host to restart into the update',
        ms: wait(ctx, 90_000),
        every: 500,
      });
      const restart = Date.now() - stoppedAt;
      await online(ctx, 90_000);
      await until(async () => row() && row().update === undefined, { what: 'the row to drop the update state', ms: wait(ctx, 60_000) });
      const versions = (await ctx.m.run(`ls "${ctx.state.dataDir}/updates/versions"`)).stdout.trim();
      return `sent ${sent.version} in ${upload} ms; Host ${before} kept serving the turn, restarted as ${after} ${restart} ms after it ended; staged build ${versions}`;
    },
  },
  {
    id: 'B10',
    title: 'Remove from the app stops the Host and deletes its files, then forgets the machine',
    async run(ctx) {
      const plan = await until(async () => ((p) => (p.busy === 'no' ? p : null))(await ctx.state.machines.removePlan(ctx.state.id)), {
        what: 'the Host to say no turn runs',
        ms: wait(ctx, 30_000),
      });
      expect(plan.ssh && plan.online, `The plan said ${JSON.stringify(plan)}.`);
      const startedAt = Date.now();
      const out = await ctx.state.machines.uninstallHost(ctx.state.id, '');
      expect(out.left === '', `Something was left: ${out.left}.`);
      await until(async () => !(await ctx.m.run(SERVE)).stdout.trim(), { what: 'the Host process to end', every: 500 });
      const gone = await ctx.m.run(
        `test ! -e "$HOME/.mopilot-host" && test ! -e "${ctx.state.dataDir}" && test ! -S "${ctx.state.socket}" && echo gone`,
      );
      expect(gone.stdout.includes('gone'), 'The Host’s files or socket are still on the machine.');
      ctx.state.machines.remove(ctx.state.id);
      expect(!ctx.state.machines.list().machines.some((m) => m.id === ctx.state.id), 'The machine is still listed.');
      ctx.state.id = null;
      return `uninstalled in ${Date.now() - startedAt} ms: process, install tree, data folder and socket gone; machine forgotten`;
    },
  },
];

/** What the run leaves behind goes: the app's side (tunnels, connections, the machine's record) and the Host on the machine. @param {any} ctx */
export async function cleanup(ctx) {
  try {
    if (ctx.state.id) ctx.state.machines?.remove(ctx.state.id);
  } finally {
    ctx.state.machines?.dispose();
    await cleanMachine(ctx);
  }
}
