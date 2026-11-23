// Harness-neutral preview tool contracts, start authorization and browser-pane opening.
const { fs } = require('../../../platform/ports/fs.cjs');
const path = require('node:path');
const { ToolError } = require('../../contract/registry.cjs');
const { originOf } = require('../origins.cjs');
const { oneLine } = require('../host.cjs');
const { readLaunchConfigs, portOf, READY_MS } = require('./launch.cjs');

const SERVER_ID = { type: 'string', description: 'A server id from preview_start or preview_list.' };

/** name -> { description, inputSchema, policy } (Registry names; Claude sees them without "browser_") */
const SPECS = {
  browser_preview_start: {
    policy: 'act',
    description:
      'Start a dev server and open it in this chat\'s tab of the MoPilot built-in browser once its port answers. name: a configuration from the project\'s .mopilot/launch.json or .claude/launch.json ({"configurations": [{"name", "runtimeExecutable", "runtimeArgs", "port", "url"?}]}; with one configuration it may be omitted). command: a shell command to run instead (give url, or let the server print its local URL). url alone: attach to a server already running (from a terminal, say) and open it. cwd: the folder to run in (default: the project folder). A server already running for the same configuration or command is reused. Starting a process asks the user unless the chat has Full access. Servers keep running across turns and stop when the app quits; approved local launch details are saved so reopening their page after restart restores the server. Explicit stop or archive forgets them. A temporary shell process or url-only attachment cannot be restored.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A launch configuration name.' },
        command: { type: 'string', description: 'A shell command that starts the server, e.g. "npm run dev".' },
        url: { type: 'string', description: 'The URL the server serves (or the one to attach to), e.g. http://localhost:5173.' },
        cwd: { type: 'string', description: 'The folder to run in: absolute, or relative to the project folder.' },
      },
    },
  },
  browser_preview_stop: {
    policy: 'act',
    description: 'Stop a preview server this chat started (and everything it launched). An attached server is only forgotten.',
    inputSchema: { type: 'object', properties: { serverId: SERVER_ID }, required: ['serverId'] },
  },
  browser_preview_list: {
    policy: 'observe',
    description: "List this chat's preview servers (id, status, URL, pid) and the launch configurations the project defines.",
    inputSchema: { type: 'object', properties: {} },
  },
  browser_preview_logs: {
    policy: 'observe',
    description:
      'A preview server\'s output (stdout and stderr, the last 2,000 lines kept). level: "all" (default) or "error" (lines mentioning error, exception, failed or fatal). search keeps lines containing the text. lines: how many of the last lines to return (default 50, at most 500).',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: SERVER_ID,
        level: { type: 'string', enum: ['all', 'error'] },
        search: { type: 'string' },
        lines: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['serverId'],
    },
  },
};

const describe = (s) =>
  `${s.id} [${s.status}] ${s.name ? `${s.name}: ` : ''}${oneLine(s.display, 200)}${s.url ? ` → ${s.url}` : s.port ? ` → port ${s.port}` : ''}${s.pid ? ` (pid ${s.pid})` : ''}${s.tabId ? ` in ${s.tabId}` : ''}`;

/**
 * Opens a URL in the chat's browser pane: the server's own tab when it still has one, else a new tab
 * marked deliverable (it stays after the turn). `ask`: a new origin asks the user (inside a tool call);
 * without it the page opens only when the chat already allows its origin. Resolves the tab, or null.
 */
function paneOpener({ tabs, grants }) {
  return async (chatId, url, { ask = false, tabId = null, segmentId = chatId } = {}) => {
    const ctx = { chatId, segmentId };
    if (ask) await grants.require(url, 'read', ctx, { offer: 'write', localAlways: false });
    else if (grants.peek(url, 'read', ctx) !== 'ok') return null;
    let tab = tabId ? (tabs.list(chatId).find((t) => t.id === tabId) ?? null) : null;
    if (!tab) {
      tab = await tabs.create(chatId, { focus: true });
      tabs.mark(chatId, tab.id, 'deliverable');
    } else tabs.select(chatId, tab.id);
    await tabs.run(tab, async () => {
      await tabs.ready(tab, chatId);
      await tabs.navigate(tab, url);
    });
    return tab;
  };
}

/**
 * The preview tools, ready for Registry.register.
 * @param {{ previews: InstanceType<typeof import('./servers.cjs').DevPreviews>, open: ReturnType<typeof paneOpener>, projectOf: (chatId: string) => Promise<string | null>,
 *           anchor?: (ctx: { chatId: string, segmentId: string }) => string,
 *           confirm?: ((ctx: any, req: { command: string, cwd: string }) => Promise<boolean>) | null,
 *           localDataAllowed?: (chatId: string) => boolean,
 *           enabled?: () => true | string, isDir?: (p: string) => boolean, readyMs?: number,
 *           platform?: string, shell?: string, readFile?: (p: string) => string }} o
 */
function createPreviewTools(o) {
  const { previews, open, projectOf } = o;
  const anchor = o.anchor ?? (() => 'ask');
  const enabled = o.enabled ?? (() => true);
  const isDir = o.isDir ?? ((p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false);
  const readyMs = o.readyMs ?? READY_MS;
  const platform = o.platform ?? process.platform;
  const shell = o.shell ?? (platform === 'win32' ? 'cmd.exe' : '/bin/sh');
  /** chat id -> commands (with their folder) the user allowed in that chat */
  const allowed = new Map();
  const configsOf = (project) => readLaunchConfigs(project, o.readFile ? { readFile: o.readFile } : undefined);

  const checkOwner = (ctx) => {
    if (o.localDataAllowed?.(ctx.chatId) === false)
      throw new ToolError('Preview servers use this Mac and are unavailable for a chat on another Host.', 'unavailable');
  };
  const live = () => {
    const on = enabled();
    if (on !== true) throw new ToolError(typeof on === 'string' ? on : 'Dev-server previews are turned off.', 'disabled');
  };

  /** Starting a process: refused in a read-only chat, asked once per command and folder otherwise (Full access: never). */
  const authorize = async (ctx, display, cwd) => {
    let a;
    try {
      a = anchor(ctx);
    } catch {
      a = 'ask';
    }
    if (a === 'readOnly')
      throw new ToolError(
        'This chat is in a read-only mode: it can attach to a running server (preview_start with url) but not start one.',
        'read_only',
      );
    if (a === 'full') return;
    const key = JSON.stringify([display, cwd]);
    if (allowed.get(ctx.chatId)?.has(key)) return;
    if (!o.confirm) throw new ToolError('Starting dev servers is turned off for this chat.', 'disabled');
    const ok = await o.confirm(ctx, { command: display, cwd });
    if (!ok) throw new ToolError('The user did not allow starting this server.', 'denied');
    if (!allowed.has(ctx.chatId)) allowed.set(ctx.chatId, new Set());
    allowed.get(ctx.chatId).add(key);
  };

  const folder = (project, cwd) => {
    if (cwd == null || cwd === '') {
      if (!project) throw new ToolError('This chat has no project folder: give cwd.', 'bad_args');
      return project;
    }
    const dir = path.isAbsolute(String(cwd)) ? String(cwd) : project ? path.resolve(project, String(cwd)) : null;
    if (!dir) throw new ToolError('cwd must be an absolute path: this chat has no project folder.', 'bad_args');
    if (!isDir(dir)) throw new ToolError(`No such folder: ${oneLine(dir, 300)}`, 'bad_args');
    return dir;
  };

  const checkUrl = (url) => {
    if (url == null) return null;
    const u = String(url).includes('://') ? String(url) : `http://${url}`;
    if (!originOf(u)) throw new ToolError(`Only http and https URLs can be previewed: ${oneLine(url, 200)}`, 'bad_args');
    return u;
  };

  /** Waits for the server, then opens it; the text the tool returns. */
  const openWhenReady = async (s, ctx, reused) => {
    const outcome = await previews.waitReady(s, { timeoutMs: readyMs, signal: ctx.signal });
    checkOwner(ctx);
    const head = `${reused ? 'Reusing' : s.proc ? 'Started' : 'Attached to'} ${describe(s)}.`;
    if (outcome === 'exited') {
      const tail = previews
        .logs(s, { lines: 20 })
        .map((l) => l.text)
        .join('\n');
      throw new ToolError(
        `${head} It exited before it was ready (${s.exitCode != null ? `code ${s.exitCode}` : s.signal || 'no exit code'}). Its last output:\n${tail}`,
        'failed',
      );
    }
    if (outcome !== 'ready') {
      // it opens by itself once ready, if the chat already allows its site
      s.autoOpen = true;
      return `${head} It isn't answering on ${s.port ? `port ${s.port}` : 'a port yet (no port configured and no local URL printed so far)'}; it keeps starting in the background. Check preview_logs ${s.id}, then call preview_start again to open it.`;
    }
    previews.remember(s);
    const tab = await open(ctx.chatId, s.url, { ask: true, tabId: s.tabId, segmentId: ctx.segmentId });
    s.tabId = tab.id;
    return `${head} Opened ${s.url} in ${tab.id} (it stays open after this turn).${s.restoreError ? ` ${s.restoreError}` : ''}`;
  };

  const impl = {
    async browser_preview_start(args, ctx) {
      const project = await projectOf(ctx.chatId);
      checkOwner(ctx);
      const url = checkUrl(args.url);
      if (args.name != null && args.command != null) throw new ToolError('Give name or command, not both.', 'bad_args');
      if (args.name == null && args.command == null) {
        if (url) {
          const prev = previews.find(ctx.chatId, { url });
          return openWhenReady(prev ?? previews.attach(ctx.chatId, url), ctx, !!prev);
        }
        const { configs } = configsOf(project);
        if (configs.length !== 1) {
          throw new ToolError(
            configs.length
              ? `Name a configuration: ${configs.map((c) => c.name).join(', ')}.`
              : 'Give name, command or url: this project has no .mopilot/launch.json or .claude/launch.json configuration.',
            'bad_args',
          );
        }
        args = { ...args, name: configs[0].name };
      }
      let spec;
      if (args.name != null) {
        const { configs, errors } = configsOf(project);
        const c = configs.find((x) => x.name === String(args.name));
        if (!c)
          throw new ToolError(
            `No launch configuration "${oneLine(args.name, 80)}"${configs.length ? `; this project has: ${configs.map((x) => x.name).join(', ')}` : ' (no .mopilot/launch.json or .claude/launch.json in the project folder)'}.${errors.length ? ` ${errors.join('; ')}` : ''}`,
            'bad_args',
          );
        const cwd = args.cwd != null && args.cwd !== '' ? folder(project, args.cwd) : c.cwd;
        if (!isDir(cwd)) throw new ToolError(`No such folder: ${oneLine(cwd, 300)}`, 'bad_args');
        spec = {
          name: c.name,
          run: [c.runtimeExecutable, ...c.runtimeArgs],
          display: [c.runtimeExecutable, ...c.runtimeArgs].join(' '),
          cwd,
          port: c.port,
          url: url ?? c.url,
          env: c.env,
        };
      } else {
        const command = String(args.command).trim();
        if (!command) throw new ToolError('command is empty.', 'bad_args');
        const cwd = folder(project, args.cwd);
        spec = {
          name: null,
          // cmd /s /c "<line>": the outer quotes go, and the line keeps its own (cd "C:\My App" && npm start)
          run: platform === 'win32' ? [shell, '/d', '/s', '/c', `"${command}"`] : [shell, '-c', command],
          verbatim: platform === 'win32',
          display: command,
          cwd,
          port: url ? portOf(url) : null,
          url,
          env: {},
        };
      }
      const existing = previews.find(ctx.chatId, spec.name ? { name: spec.name } : { command: spec.display, cwd: spec.cwd });
      if (existing) return openWhenReady(existing, ctx, true);
      // something already serves the port (the user's terminal): attach instead of a second copy
      if (spec.port && (await previews.probe(spec.port, 'localhost'))) {
        checkOwner(ctx);
        const s = previews.attach(ctx.chatId, spec.url ?? `http://localhost:${spec.port}/`);
        return `Port ${spec.port} is already serving, so nothing was started. ${await openWhenReady(s, ctx, false)}`;
      }
      await authorize(ctx, spec.display, spec.cwd);
      checkOwner(ctx);
      spec.project = project;
      const s = previews.start(ctx.chatId, spec);
      return openWhenReady(s, ctx, false);
    },

    async browser_preview_stop(args, ctx) {
      const s = previews.stop(ctx.chatId, args.serverId);
      return s.proc
        ? `Stopped ${s.id} (${oneLine(s.display, 200)}).`
        : `Forgot ${s.id}; it wasn't started by MoPilot, so it keeps running.`;
    },

    async browser_preview_list(_args, ctx) {
      const list = previews.list(ctx.chatId);
      const project = await projectOf(ctx.chatId);
      checkOwner(ctx);
      const { configs, errors } = configsOf(project);
      const lines = [
        list.length
          ? `Preview servers in this chat:\n${list.map((s) => `- ${describe(s)}`).join('\n')}`
          : 'No preview servers in this chat.',
      ];
      if (configs.length)
        lines.push(`Launch configurations: ${configs.map((c) => `${c.name} (${c.source}${c.port ? `, port ${c.port}` : ''})`).join(', ')}`);
      else lines.push('No launch configurations (.mopilot/launch.json or .claude/launch.json) in the project folder.');
      if (errors.length) lines.push(`Problems: ${errors.join('; ')}`);
      return lines.join('\n');
    },

    async browser_preview_logs(args, ctx) {
      const s = previews.get(ctx.chatId, args.serverId);
      const level = args.level === 'error' ? 'error' : 'all';
      const list = previews.logs(s, { level, search: args.search || null, lines: args.lines ?? 50 });
      const head = describe(s);
      if (!list.length)
        return `${head}\nNo ${level === 'error' ? 'error ' : ''}output${args.search ? ` containing "${oneLine(args.search, 80)}"` : ''}.`;
      return `${head}\n${list.map((l) => `${l.stream === 'stderr' ? '! ' : l.stream === 'system' ? '# ' : ''}${l.text}`).join('\n')}`;
    },
  };

  return Object.entries(SPECS).map(([name, spec]) => ({
    name,
    description: spec.description,
    schema: spec.inputSchema,
    policy: spec.policy,
    // starting asks inside (what a call runs is only known there); opening asks for the site
    authorizesItself: true,
    handler: async (args, ctx) => {
      live();
      checkOwner(ctx);
      return impl[name](args, ctx);
    },
  }));
}

/** Registers the tools in a capability Registry; returns a function that unregisters them. */
function registerPreviewTools(registry, deps) {
  const offs = createPreviewTools(deps).map((t) => registry.register(t));
  return () => offs.forEach((off) => off());
}

module.exports = { createPreviewTools, registerPreviewTools, paneOpener, SPECS };
