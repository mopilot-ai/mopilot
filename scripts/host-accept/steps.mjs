// The steps of the Host's real-machine acceptance run, in order. Each takes the run's context and returns what it saw, or throws what was wrong. A step uses only what `ctx` gives it (the machine's channel, the app's own installer and pairing client), so the whole run can be tried against a stand-in machine.
import { HOST_CLI } from '../../electron/host/install.cjs';
import { lineClient } from './wire.mjs';
import { workFolder } from './workFolder.mjs';

/** The Host's executable on the machine, as the installer runs it. */
const CLI = HOST_CLI;
/** The folder on the machine that holds what the run uploads. */
const WORK = '$HOME/.mopilot-accept';
/** Where the default Host keeps its identity, pairings and relay enrollments (host/src/paths.mjs). */
const CONFIG_DIR = '"${XDG_CONFIG_HOME:-$HOME/.config}/mopilot-host"';
/** A bracketed first letter keeps pgrep from matching the shell that runs this very line (its command line holds the pattern), which `bash -c` on Linux would. */
const SERVICE_LINE = "pgrep -f '[m]opilot-host.mjs serve' | head -1";
const AGENT_LINE = "pgrep -f '[f]ake-acp-agent.mjs'";

/** What a command printed, for a failure message. @param {{ stdout: string, stderr: string }} r */
const why = (r) =>
  [r.stderr, r.stdout]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' / ');

/** A chat id of this run: a data folder kept from an earlier run (--keep) holds its chats' keys, which would answer instead of starting a turn. @param {any} ctx @param {number} n */
export const chat = (ctx, n) => `acp:fake:accept${n}-${ctx.nonce}`;

/** @param {unknown} condition @param {string} message */
export const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Run `check` until it returns something truthy; a check that throws is tried again, and its last error is part of the timeout. @param {() => Promise<any>} check @param {{ ms?: number, every?: number, what: string }} o */
export async function until(check, { ms = 60_000, every = 500, what }) {
  const end = Date.now() + ms;
  let last = '';
  for (;;) {
    try {
      const v = await check();
      if (v) return v;
    } catch (e) {
      last = ` (last error: ${/** @type {Error} */ (e).message})`;
    }
    expect(Date.now() < end, `Timed out waiting for ${what}${last}.`);
    await new Promise((r) => setTimeout(r, every));
  }
}

/** A chat's reply on the stream: the assistant item the Host wrote, once. @param {string} chatId */
export const replyOf = (chatId) => (/** @type {any} */ e) => e.chatId === chatId && e.frame?.item?.t === 'assistant';

/** A connection to the Host's socket on the machine. @param {any} ctx */
export function connect(ctx) {
  return lineClient(ctx.m.open(`nc -U '${ctx.state.socket}'`), { tap: ctx.trace?.tapFor() });
}

/** A paired, said-hello connection. @param {any} ctx */
export async function session(ctx) {
  const c = connect(ctx);
  const request = (/** @type {string} */ method, /** @type {object} */ params) => c.request(method, params);
  await ctx.deps.authenticate(request, ctx.state.identity);
  const hello = await c.request('host.hello', ctx.deps.helloParams());
  expect(hello.agreed, 'The Host and this run agree on no version.');
  return c;
}

/** Start a chat (on the fake ACP harness unless `start` says another: harness, cwd, permission, model, effort) and subscribe to it. @param {any} ctx @param {string} chatId @param {string} text @param {Record<string, unknown>} [start] */
export async function ask(ctx, chatId, text, start = {}) {
  const c = await session(ctx);
  await c.request('chat.subscribe', { chatId, epoch: 1, fromRev: 0 });
  await c.request('chat.start', {
    chatId,
    epoch: 1,
    key: `accept-${chatId}`,
    harness: 'acp:fake',
    text,
    cwd: workFolder(ctx.state),
    ...start,
  });
  return c;
}

/** Wait until the Host answers `status` again; returns the status and the Host's pid. @param {any} ctx @param {string} [notPid] a pid the Host must have left @param {number} [ms] how long to wait */
export async function hostUp(ctx, notPid = '', ms = 60_000) {
  return until(
    async () => {
      const pid = (await ctx.m.run(SERVICE_LINE)).stdout.trim();
      if (!pid || pid === notPid) return null;
      const c = connect(ctx);
      try {
        return { status: await c.request('status'), pid };
      } finally {
        c.close();
      }
    },
    { ms, what: 'the Host to answer', every: 1000 },
  );
}

/**
 * Put the repo's fake ACP agent on the machine and tell the Host about it (harnesses.json); the Host reads that file at its next start.
 * @param {any} ctx needs `m`, `deps.agentFiles` and `state.dataDir`, `state.nodePath`
 */
export async function provideFakeAgent(ctx) {
  const dir = `${ctx.state.dataDir}/accept-agent`;
  for (const f of ctx.deps.agentFiles()) await ctx.m.run(`mkdir -p "$(dirname "${dir}/${f.rel}")" && cat > "${dir}/${f.rel}"`, f.data);
  const harnesses = {
    fake: {
      label: 'Fake',
      bin: ctx.state.nodePath,
      args: [`${dir}/tests/fixtures/fake-acp-agent.mjs`],
      env: { FAKE_ACP_STATE: `${dir}/state`, FAKE_STAY: '1' },
    },
  };
  await ctx.m.run(`cat > "${ctx.state.dataDir}/harnesses.json"`, Buffer.from(JSON.stringify(harnesses)));
}

/** The service restart for the machine's system. @param {any} ctx */
export const restart = (ctx) =>
  ctx.m.run(ctx.state.os === 'Darwin' ? 'launchctl kickstart -k "gui/$(id -u)/ai.mopilot.host"' : 'systemctl --user restart mopilot-host');

/** @type {{ id: string, title: string, fatal?: boolean, run: (ctx: any) => Promise<string | { skip: string }> }[]} */
export const STEPS = [
  {
    id: 'A1',
    title: 'The machine can run the Host (Node 22+, nc)',
    fatal: true,
    async run(ctx) {
      const r = await ctx.m.run('uname -sm; node --version; command -v nc; command -v node');
      expect(r.code === 0, `The machine could not be asked: ${why(r)}`);
      const [uname, node, , nodePath] = r.stdout.trim().split('\n');
      expect(parseInt(node.slice(1), 10) >= 22, `Node 22 or newer is needed (found ${node}).`);
      ctx.state.os = uname.split(' ')[0];
      ctx.state.platform = uname;
      ctx.state.nodePath = nodePath;
      return `${uname}, Node ${node}`;
    },
  },
  {
    id: 'A2',
    title: 'Build the Host tarball the app uploads',
    fatal: true,
    async run(ctx) {
      // the machine's build is known once the installer has its Node there: the installer asks for it, as the app's does
      ctx.state.bundleFor = (/** @type {string} */ build) =>
        (ctx.state.bundle = ctx.deps.buildBundle({ root: ctx.root, outDir: ctx.outDir, build }));
      const { files, sha256, version } = ctx.deps.buildBundle({ root: ctx.root, outDir: ctx.outDir });
      return `${files} files, version ${version}, sha ${sha256.slice(0, 12)} without the core`;
    },
  },
  {
    id: 'A3',
    title: 'Install the Host with the app’s installer (upload, verify, unpack, service, status)',
    fatal: true,
    async run(ctx) {
      const installer = ctx.deps.createInstaller({
        channel: (/** @type {string} */ _d, /** @type {string} */ command, /** @type {Buffer} */ input) => ctx.m.run(command, input),
        bundle: ctx.state.bundleFor,
      });
      const res = await installer.install(ctx.target);
      expect(res.ok, `Failed at ${res.failedStep}: ${res.error}`);
      expect(res.pairingCode, 'The Host printed no pairing code.');
      ctx.state.code = res.pairingCode;
      ctx.state.socket = res.status.socketPath;
      ctx.state.dataDir = res.status.socketPath.replace(/\/[^/]*$/, '');
      return `Host ${res.status.version}; steps ${res.steps.map((s) => `${s.id}:${s.state}`).join(' ')}`;
    },
  },
  {
    id: 'A4',
    title: 'Status reports harnesses, capabilities and isolation',
    async run(ctx) {
      const c = connect(ctx);
      try {
        const s = await c.request('status');
        expect(s.running === true, 'The Host says it is not running.');
        expect(Array.isArray(s.harnesses) && s.harnesses.length > 0, 'Status lists no harnesses.');
        expect(typeof s.capabilities === 'object' && typeof s.capabilities.iab === 'boolean', 'Status declares no browser capability.');
        // a tarball that carried the core must have a Host that loaded it: `routes()` answered
        const carried = ctx.state.bundle.core;
        if (carried)
          expect(
            s.core?.loaded && s.core.build === carried && s.core.routes > 0,
            `The Host did not load its ${carried} core: ${JSON.stringify(s.core)}.`,
          );
        const harnesses = s.harnesses.map((h) => `${h.id}:${h.detected ? 'installed' : 'absent'}/${h.signedIn ? 'in' : 'out'}`).join(' ');
        return `v${s.version} on ${s.platform}; core ${s.core?.loaded ? `${s.core.build}, ${s.core.routes} routes` : 'not loaded'}; ${harnesses}; iab ${s.capabilities.iab}; isolation ${s.isolation.delivered.length} delivered, ${s.isolation.blocked.length} blocked`;
      } finally {
        c.close();
      }
    },
  },
  {
    id: 'A5',
    title: 'Pairing: chat requests refused before it, accepted after',
    async run(ctx) {
      const c = connect(ctx);
      try {
        const request = (/** @type {string} */ method, /** @type {object} */ params) => c.request(method, params);
        const refused = await c.request('chat.subscribe', { chatId: 'acp:fake:accept', epoch: 1 }).then(
          () => null,
          (/** @type {any} */ e) => e,
        );
        expect(refused && refused.code === 'unknown_client', 'An unpaired client was not refused with unknown_client.');
        ctx.state.identity = ctx.deps.loadIdentity(`${ctx.outDir}/identity.json`, ctx.deps.keySafe);
        await ctx.deps.pairWith(request, ctx.state.identity, ctx.state.code);
      } finally {
        c.close();
      }
      const paired = await session(ctx);
      paired.close();
      return 'refused (unknown_client) before pairing; paired, authenticated and said hello after';
    },
  },
  {
    id: 'A6',
    title: 'An ACP chat on the fake agent runs a turn',
    async run(ctx) {
      await provideFakeAgent(ctx);
      await restart(ctx);
      ctx.state.pid = (await hostUp(ctx)).pid;
      const started = Date.now();
      const c = await ask(ctx, chat(ctx, 1), 'hello from acceptance');
      try {
        const reply = (await c.waitFor(replyOf(chat(ctx, 1)), 30_000)).frame.item;
        expect(reply.text === 'fake-acp: hello from acceptance', `The reply was "${reply.text}".`);
        expect(reply.stopReason === 'end_turn', `The turn ended with ${reply.stopReason}.`);
        return `reply "${reply.text}" in ${Date.now() - started} ms after a service restart`;
      } finally {
        c.close();
      }
    },
  },
  {
    id: 'A7',
    title: 'kill -9 mid-turn: the next Host ends the child and the turn as interrupted',
    async run(ctx) {
      const c = await ask(ctx, chat(ctx, 2), 'SLOW please');
      const agents = await until(async () => (await ctx.m.run(AGENT_LINE)).stdout.trim().split('\n').filter(Boolean).join(' ') || null, {
        what: 'the agent of the running turn',
        every: 200,
      });
      c.close();
      await ctx.m.run(`kill -9 ${ctx.state.pid}`);
      const up = await hostUp(ctx, ctx.state.pid);
      ctx.state.pid = up.pid;
      const again = await session(ctx);
      try {
        await again.request('chat.subscribe', { chatId: chat(ctx, 2), epoch: 1, fromRev: 0 });
        const end = await again.waitFor((e) => e.chatId === chat(ctx, 2) && e.frame?.item?.event?.kind === 'turnEnd', 30_000);
        expect(end.frame.item.event.stopReason === 'cancelled', `The turn ended with ${end.frame.item.event.stopReason}.`);
      } finally {
        again.close();
      }
      await until(async () => !(await ctx.m.run(AGENT_LINE)).stdout.trim(), { what: `the old agent (${agents}) to be ended`, every: 200 });
      const next = await ask(ctx, chat(ctx, 3), 'after the crash');
      try {
        const reply = (await next.waitFor(replyOf(chat(ctx, 3)), 30_000)).frame.item;
        expect(reply.text === 'fake-acp: after the crash', `The next turn said "${reply.text}".`);
      } finally {
        next.close();
      }
      return `Host ${ctx.state.pid} replaced the killed one; agent ${agents} ended; the turn read as cancelled; a new turn ran`;
    },
  },
  {
    id: 'A8',
    title: 'Update to the same build with `mopilot-host update --manifest`',
    async run(ctx) {
      const { file, manifest } = ctx.state.bundle;
      await ctx.m.run(`mkdir -p ${WORK} && cat > ${WORK}/${file.replace(/^.*\//, '')}`, ctx.deps.readFile(file));
      // the Host takes an update only from a manifest the app it is paired with signed for it: its name is in its challenge
      const c = connect(ctx);
      let hostId;
      try {
        hostId = (await c.request('host.challenge', {})).hostId;
      } finally {
        c.close();
      }
      const now = Date.now();
      const facts = { ...JSON.parse(ctx.deps.readFile(manifest).toString('utf8')), hostId, seq: now, notAfter: now + 3_600_000 };
      const unsigned = await ctx.m.run(`cat > ${WORK}/unsigned.json`, Buffer.from(JSON.stringify(facts)));
      expect(unsigned.code === 0, `could not put the manifest on the machine: ${why(unsigned)}`);
      const refused = await ctx.m.run(`${CLI} update --manifest ${WORK}/unsigned.json`);
      expect(
        refused.code !== 0 && /not signed by a key this Host trusts/.test(refused.stderr + refused.stdout),
        `An unsigned manifest was not refused: ${why(refused)}`,
      );
      await ctx.m.run(
        `cat > ${WORK}/manifest.json`,
        Buffer.from(JSON.stringify({ ...facts, signature: ctx.state.identity.signManifest(facts) })),
      );
      const r = await ctx.m.run(`${CLI} update --manifest ${WORK}/manifest.json`);
      expect(r.code === 0, `update exited ${r.code}: ${why(r)}`);
      const up = await hostUp(ctx);
      ctx.state.pid = up.pid;
      // a version taken by update runs from another folder than the installed one: its core must load from there too
      const carried = ctx.state.bundle.core;
      if (carried)
        expect(
          up.status.core?.loaded && up.status.core.build === carried,
          `The updated Host did not load its core: ${JSON.stringify(up.status.core)}.`,
        );
      return `an unsigned manifest was refused; ${r.stdout.trim().replace(/\n/g, ' / ')}; Host answers as ${up.status.version}${carried ? ` with its ${carried} core` : ''}`;
    },
  },
  {
    id: 'A11',
    title: 'git.status reads a repository on the machine, hardened, inside the roots, for a paired client only',
    async run(ctx) {
      // a repository whose own config names programs to run (fsmonitor, a clean filter): reading its status must not run them
      const repo = `${WORK}/status-repo`;
      const made = await ctx.m.run(
        `rm -rf "${repo}" && mkdir -p "${repo}" && cd "${repo}" && git init -q && git config user.email a@b.c && git config user.name t && ` +
          `printf '1\\n2\\n' > a.txt && git add a.txt && git commit -qm one && git checkout -qb feature && printf '1\\n2\\n3\\n' > a.txt && printf 'x\\n' > new.txt && ` +
          `printf '#!/bin/sh\\ntouch "$HOME/.mopilot-accept/ran"\\n' > "$HOME/.mopilot-accept/evil.sh" && chmod +x "$HOME/.mopilot-accept/evil.sh" && ` +
          `git config core.fsmonitor "$HOME/.mopilot-accept/evil.sh" && git config filter.a.clean "$HOME/.mopilot-accept/evil.sh" && printf 'a.txt filter=a\\n' > .gitattributes && rm -f "$HOME/.mopilot-accept/ran"`,
      );
      expect(made.code === 0, `could not make the repository: ${why(made)}`);
      const home = (await ctx.m.run('printf %s "$HOME"')).stdout.trim();
      const folder = `${home}/.mopilot-accept/status-repo`;
      const stranger = connect(ctx);
      const refused = await stranger.request('git.status', { path: folder }).catch((/** @type {any} */ e) => e.code);
      expect(refused === 'unknown_client', `An unpaired connection was not refused (${JSON.stringify(refused)}).`);
      const c = await session(ctx);
      const s = await c.request('git.status', { path: folder });
      expect(s.isRepo && s.branch === 'feature', `Unexpected status: ${JSON.stringify(s)}`);
      expect(
        s.files.some((/** @type {any} */ f) => f.path === 'a.txt' && f.added === 1),
        'The edited file is not listed with its added line.',
      );
      expect(
        s.files.some((/** @type {any} */ f) => f.path === 'new.txt' && f.untracked),
        'The untracked file is not listed.',
      );
      const ran = await ctx.m.run('test -e "$HOME/.mopilot-accept/ran" && echo ran');
      expect(!ran.stdout.includes('ran'), 'The repository made git run a program it named (fsmonitor or a clean filter).');
      // a link inside the roots that leaves them is refused by its real path
      await ctx.m.run(`ln -sfn /tmp "${WORK}/out-link"`);
      const out = await c.request('git.status', { path: `${home}/.mopilot-accept/out-link` }).catch((/** @type {any} */ e) => e.code);
      expect(out === 'outside_roots', `A link out of the roots was not refused (${JSON.stringify(out)}).`);
      await ctx.m.run(`rm -rf "${repo}" "${WORK}/out-link" "$HOME/.mopilot-accept/evil.sh"`);
      return `branch ${s.branch}, ${s.files.length} files; an unpaired client got unknown_client; the programs the repository named (fsmonitor, a clean filter) stayed unrun; a link out of the roots got outside_roots`;
    },
  },
  {
    id: 'A12',
    title: 'fs.tree and fs.read list and read files on the machine: roots by real path, regular files only, paired clients only',
    async run(ctx) {
      const dir = `${WORK}/files-view`;
      const made = await ctx.m.run(
        `rm -rf "${dir}" && mkdir -p "${dir}/src" && printf 'hello from the machine\\n' > "${dir}/README.md" && printf 'x\\0y' > "${dir}/blob.bin" && ` +
          `mkfifo "${dir}/pipe" && ln -sfn /tmp "${dir}/out-link" && ln -sfn /etc/hosts "${dir}/out-file"`,
      );
      expect(made.code === 0, `could not make the folder: ${why(made)}`);
      const home = (await ctx.m.run('printf %s "$HOME"')).stdout.trim();
      const folder = `${home}/.mopilot-accept/files-view`;
      const stranger = connect(ctx);
      const refused = await stranger.request('fs.read', { path: `${folder}/README.md` }).catch((/** @type {any} */ e) => e.code);
      expect(refused === 'unknown_client', `An unpaired connection was not refused (${JSON.stringify(refused)}).`);
      const c = await session(ctx);
      const tree = await c.request('fs.tree', { path: folder });
      const names = tree.entries.map((/** @type {any} */ e) => e.name);
      expect(
        names[0] === 'src' && [...names].sort().join(',') === 'README.md,blob.bin,src',
        `Unexpected entries (folders first): ${names.join(',')}`,
      );
      const text = await c.request('fs.read', { path: `${folder}/README.md` });
      expect(text.kind === 'text' && text.text === 'hello from the machine\n', `Unexpected text: ${JSON.stringify(text)}`);
      const bin = await c.request('fs.read', { path: `${folder}/blob.bin` });
      expect(bin.kind === 'binary' && bin.size === 3, `Unexpected binary answer: ${JSON.stringify(bin)}`);
      const code = (/** @type {string} */ method, /** @type {string} */ at) =>
        c.request(method, { path: at }).catch((/** @type {any} */ e) => e.code);
      expect((await code('fs.read', `${folder}/pipe`)) === 'not_a_file', 'A pipe was not refused as not_a_file.');
      expect((await code('fs.read', `${folder}/out-file`)) === 'outside_roots', 'A link out of the roots was not refused (file).');
      expect((await code('fs.tree', `${folder}/out-link`)) === 'outside_roots', 'A link out of the roots was not refused (folder).');
      await ctx.m.run(`rm -rf "${dir}"`);
      return 'listed folders first, read text and a binary size; a pipe got not_a_file, links out of the roots got outside_roots; an unpaired client got unknown_client';
    },
  },
  {
    id: 'A13',
    title: 'git.diff reads a repository’s patch on the machine, hardened, confined to the folder, for paired clients only',
    async run(ctx) {
      const repo = `${WORK}/diff-repo`;
      const made = await ctx.m.run(
        `rm -rf "${repo}" && mkdir -p "${repo}/sub" && cd "${repo}" && git init -q && git config user.email a@b.c && git config user.name t && ` +
          `printf '1\\n2\\n' > a.txt && printf 'in\\n' > sub/in.txt && git add . && git commit -qm one && git checkout -qb feature && ` +
          `printf '1\\n2\\n3\\n' > a.txt && git commit -qam two && printf '4\\n' >> a.txt && printf 'edited\\n' >> sub/in.txt && printf 'fresh\\n' > new.txt && ` +
          `printf '#!/bin/sh\\ntouch "$HOME/.mopilot-accept/diff-ran"\\ncat\\n' > "$HOME/.mopilot-accept/diff-evil.sh" && chmod +x "$HOME/.mopilot-accept/diff-evil.sh" && ` +
          `git config filter.a.clean "$HOME/.mopilot-accept/diff-evil.sh" && git config 'filter.b=c.clean' "$HOME/.mopilot-accept/diff-evil.sh" && printf 'a.txt filter=a\\nnew.txt filter=b=c\\n' > .gitattributes && rm -f "$HOME/.mopilot-accept/diff-ran"`,
      );
      expect(made.code === 0, `could not make the repository: ${why(made)}`);
      const home = (await ctx.m.run('printf %s "$HOME"')).stdout.trim();
      const folder = `${home}/.mopilot-accept/diff-repo`;
      const stranger = connect(ctx);
      const refused = await stranger.request('git.diff', { path: folder, scope: 'branch' }).catch((/** @type {any} */ e) => e.code);
      expect(refused === 'unknown_client', `An unpaired connection was not refused (${JSON.stringify(refused)}).`);
      const c = await session(ctx);
      const un = await c.request('git.diff', { path: folder, scope: 'uncommitted' });
      expect(un.isRepo && /^\+4$/m.test(un.patch) && !/^\+3$/m.test(un.patch), 'The uncommitted patch is not against HEAD.');
      expect(/^\+fresh$/m.test(un.patch), 'The untracked file is not in the patch as a new file.');
      const br = await c.request('git.diff', { path: folder, scope: 'branch' });
      expect(/^\+3$/m.test(br.patch), 'The branch patch lacks the committed change.');
      const only = await c.request('git.diff', { path: `${folder}/sub`, scope: 'uncommitted' });
      expect(/^\+edited$/m.test(only.patch) && !/^\+4$/m.test(only.patch), 'A folder inside the repository saw files outside it.');
      const ran = await ctx.m.run('test -e "$HOME/.mopilot-accept/diff-ran" && echo ran');
      expect(!ran.stdout.includes('ran'), 'The repository made git run a clean filter (also one whose name holds an equals sign).');
      await ctx.m.run(`rm -rf "${repo}" "$HOME/.mopilot-accept/diff-evil.sh"`);
      return 'uncommitted and branch patches, new files included; confined to a subfolder; the clean filter stayed unrun; an unpaired client got unknown_client';
    },
  },
  {
    id: 'A9',
    title: 'Uninstall removes the service, the process and the socket',
    async run(ctx) {
      const r = await ctx.m.run(`${CLI} uninstall`);
      expect(r.code === 0, `uninstall exited ${r.code}: ${why(r)}`);
      await until(async () => !(await ctx.m.run(SERVICE_LINE)).stdout.trim(), { what: 'the Host process to end', every: 500 });
      const gone = await ctx.m.run(`test ! -S "${ctx.state.socket}" && echo gone`);
      expect(gone.stdout.includes('gone'), 'The socket is still there.');
      // the service goes, what the Host holds stays (its identity and pairings, so installing again resumes), and the output says how to delete it
      expect(r.stdout.includes('uninstall --purge'), 'Uninstall did not say what it kept and how to delete it.');
      const kept = await ctx.m.run(`test -n "$(ls -A ${CONFIG_DIR} 2>/dev/null)" && test -d "${ctx.state.dataDir}" && echo kept`);
      expect(kept.stdout.includes('kept'), 'Uninstall deleted the Host’s config or data folder.');
      return r.stdout.trim().replace(/\n/g, ' / ');
    },
  },
  {
    id: 'A10',
    title: 'An upload damaged on the way is refused at verify and removed',
    async run(ctx) {
      const { file, sha256, version } = ctx.state.bundle;
      // one byte of the archive changes in transit: the Mac's own check of the file passes, the machine's check of what arrived must not
      const damaged = (/** @type {Buffer | undefined} */ input) =>
        input && input.length > 1024 ? Buffer.concat([input.subarray(0, 512), Buffer.from([input[512] ^ 1]), input.subarray(513)]) : input;
      const installer = ctx.deps.createInstaller({
        channel: (/** @type {string} */ _d, /** @type {string} */ command, /** @type {Buffer} */ input) =>
          ctx.m.run(command, damaged(input)),
        bundle: () => ({ file, sha256, version }),
      });
      const res = await installer.install(ctx.target);
      expect(!res.ok && res.failedStep === 'verify', `Expected a failure at verify, got ${res.ok ? 'success' : res.failedStep}.`);
      const left = await ctx.m.run('ls "$HOME/.mopilot-host/incoming" 2>/dev/null | wc -l');
      expect(left.stdout.trim() === '0', 'The refused upload was left on the machine.');
      return `refused at verify (${res.error.split('\n')[0]}); the upload was removed`;
    },
  },
  {
    id: 'A14',
    title: 'Uninstall --purge deletes the Host’s data, config and install tree',
    async run(ctx) {
      const r = await ctx.m.run(`${CLI} uninstall --purge`);
      expect(r.code === 0, `uninstall --purge exited ${r.code}: ${why(r)}`);
      const left = await ctx.m.run(
        `for d in ${CONFIG_DIR} "${ctx.state.dataDir}" "$HOME/.mopilot-host"; do test ! -e "$d" || echo "left:$d"; done; echo done`,
      );
      expect(left.stdout.trim() === 'done', `Purge left files behind: ${left.stdout.trim()}`);
      return r.stdout.trim().replace(/\n/g, ' / ');
    },
  },
];

/** The script that takes the run's agent out of harnesses.json and keeps every other entry (a file left empty goes). */
const DROP_FAKE = `const fs=require("fs"),f=process.argv[1];let h;try{h=JSON.parse(fs.readFileSync(f,"utf8"))}catch{process.exit(0)}delete h.fake;Object.keys(h).length?fs.writeFileSync(f,JSON.stringify(h,null,2)):fs.rmSync(f)`;

/**
 * The fake ACP agent a run put on the machine goes, also when the Host is kept (--keep): its files and its entry in harnesses.json
 * (the person's own entries stay), so it never shows among the machine's agents in the person's app. A kept Host is restarted to read it.
 * @param {any} ctx @param {{ restartHost?: boolean }} [o]
 */
export async function removeTestAgent(ctx, { restartHost = false } = {}) {
  if (!ctx.state.dataDir) return;
  const dir = ctx.state.dataDir;
  const node = ctx.state.nodePath ? `"${ctx.state.nodePath}"` : 'node';
  await ctx.m.run(`rm -rf "${dir}/accept-agent"; [ ! -f "${dir}/harnesses.json" ] || ${node} -e '${DROP_FAKE}' "${dir}/harnesses.json"`);
  if (restartHost) await restart(ctx);
}

/** What a run leaves on the machine goes: its test agent, the Host's files, the run's uploads and its data folder. @param {any} ctx */
export async function cleanup(ctx) {
  await removeTestAgent(ctx);
  // the data folder goes only if it is plainly the Host's own
  const data = /mopilot/i.test(String(ctx.state.dataDir)) ? `"${ctx.state.dataDir}"` : '';
  await ctx.m.run(`${CLI} uninstall --purge; rm -rf "$HOME/.mopilot-host" ${WORK} ${data}`);
}
