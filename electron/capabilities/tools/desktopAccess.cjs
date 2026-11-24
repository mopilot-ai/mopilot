// The desktop tools' access: desktop_request_access and its card, the granted apps, opening apps, displays, and the user's clipboard.
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const P = require('../contract/desktopPolicy.cjs');
const { TIER_LEVEL } = require('./desktopSpecs.cjs');
const { onboarding } = require('./desktopUtil.cjs');
const { outdatedHelperText } = require('../computer.cjs');
const { checkAct, mayAct, shuttingDown, noteNoGo } = require('../contract/actionGuard.cjs');
const { SELF_NAME, refuseSelf } = require('../contract/controlRefusals.cjs');
/** @typedef {import('./desktop.cjs').Clipboard} Clipboard */
/** @typedef {import('./desktop.cjs').Clip} Clip */

/** @typedef {InstanceType<typeof import('./desktop.cjs').DesktopControl>} DesktopControl the control these methods run on */

class DesktopAccess {
  /* -- access ----------------------------------------------------- */

  /** @this {DesktopControl} */
  async requestAccess(chatId, args, ctx, teach = false) {
    const queries = [...new Set((Array.isArray(args.apps) ? args.apps : []).map((a) => String(a).trim()).filter(Boolean))].slice(0, 30);
    if (!queries.length) throw new ToolError('Name at least one app', 'bad_args');
    const helper = await this.ready();
    let resolved;
    try {
      resolved = (await helper.resolveApps(queries)).apps || [];
    } catch (e) {
      if (e?.reason === 'method_not_found') throw new ToolError(outdatedHelperText(e), 'unavailable');
      throw e;
    }
    if (!this.hostPidsP) this.hostPidsP = Promise.resolve(this.hostPids()).catch(() => new Set());
    const host = await this.hostPidsP;
    const deny = this.grants?.deny?.() || [];
    const s = this.session(chatId);
    const have = this.granted(chatId);
    // the apps the user chose "Always allow" for (Settings → Computer use lists them)
    const remembered = new Set((this.grants?.global?.() || []).map((g) => g.bundleId.toLowerCase()));
    const denied = [];
    /** MoPilot itself was asked for: the model is told where its projects, chats and browser pane are reached */
    let self = false;
    const already = [];
    const always = [];
    const ask = new Map();
    for (const r of resolved) {
      const a = r.app;
      if (!a) {
        denied.push({ app: r.query, reason: 'no app with that name or bundle id is installed' });
        continue;
      }
      const name = a.name || a.displayName || a.bundleId;
      // an app computer use never controls: the chat's transcript says so too (capabilities/contract/controlRefusals.cjs)
      if (P.anyMatch(P.HOST_BUNDLES, a.bundleId) || r.refused === SELF_NAME || (a.pid && host.has(a.pid))) {
        denied.push({ app: name, bundleId: a.bundleId, reason: 'MoPilot itself, and the apps hosting this agent, are never granted' });
        if (P.anyMatch(P.HOST_BUNDLES, a.bundleId) || r.refused === SELF_NAME) {
          noteNoGo({ reason: 'self', app: r.query, name: SELF_NAME });
          self = true;
        }
        continue;
      }
      if (r.refused) {
        denied.push({ app: name, bundleId: a.bundleId, reason: `MoPilot never controls ${r.refused}` });
        noteNoGo({ reason: 'builtIn', app: r.query, name });
        continue;
      }
      if (P.anyMatch(deny, a.bundleId)) {
        denied.push({ app: name, bundleId: a.bundleId, reason: 'blocked in Settings → Computer use' });
        noteNoGo({ reason: 'blocked', app: r.query, name });
        continue;
      }
      const k = a.bundleId.toLowerCase();
      const tier = P.tierOf(a.bundleId);
      if (have.has(k) && P.tierRank(have.get(k).tier) >= P.tierRank(tier)) {
        const g = have.get(k);
        // remembered and not yet this chat's: granted without a card, kept for the rest of the chat (a later
        // Remove in Settings stops future requests, not this chat), and named so the chat shows it
        if (remembered.has(k) && !(s.apps.has(k) && P.tierRank(s.apps.get(k).tier) >= P.tierRank(g.tier))) {
          s.apps.set(k, { bundleId: g.bundleId, name: g.name, tier: g.tier });
          always.push(g.name);
        }
        already.push(g);
        continue;
      }
      if (!ask.has(k))
        ask.set(k, {
          bundleId: a.bundleId,
          name,
          tier,
          tierLabel: P.TIER_LABEL[tier],
          warning: P.warningOf(a.bundleId),
          running: !!a.running,
        });
    }
    const flags = ['clipboardRead', 'clipboardWrite', 'systemKeyCombos'].filter((f) => args[f] === true && !s[f]);
    // the mouse and keyboard on the same card, as Claude Desktop asks once per task: only when the agent says it will
    // use the screen tools; background (desktop_app_*) work never needs it, and a chat that didn't ask gets the
    // just-in-time card on its first screen input (preflight)
    if (args.screenControl === true && !s.consent) flags.push('screenControl');
    const granted = [];
    /** the answer to the access card, when one was asked */
    let answer = null;
    // a teach tour always asks: the card is where the user agrees to be guided and to the clicks a Next makes
    if (ask.size || flags.length || teach) {
      const params = {
        ...(teach ? { teach: true } : {}),
        apps: [...ask.values()],
        denied: denied.map((d) => ({ name: d.app, reason: d.reason })),
        reason: typeof args.reason === 'string' ? args.reason.slice(0, 300) : '',
        clipboardRead: flags.includes('clipboardRead'),
        clipboardWrite: flags.includes('clipboardWrite'),
        systemKeyCombos: flags.includes('systemKeyCombos'),
        screenControl: flags.includes('screenControl'),
      };
      const unattended = await this.cu.unattended(chatId, ctx);
      if (unattended) {
        const names = [...ask.values()].map((a) => a.name).join(', ') || 'the clipboard or system shortcuts';
        const message = `Access to ${names} needs the user's OK, and nobody is here to give it (${unattended}). MoPilot paused this chat and asked the user; don't retry.`;
        const first = [...ask.values()][0];
        this.cu.onUnattended(chatId, {
          app: { bundleId: first?.bundleId || 'ai.mopilot.screen', name: names },
          code: 'unattended',
          message,
          need: null,
          tool: 'desktop_request_access',
          // the same access card, put up once the user opens the paused chat; its answer grants what this call asked for
          deferred: { kind: 'computerAccessSet', params, apply: (reply) => this.applyAccess(chatId, { ask, flags }, reply) },
        });
        throw new ToolError(message, 'unattended');
      }
      this.revealHost();
      answer = await this.broker.ask(chatId, 'computerAccessSet', { harness: this.cu.harness(chatId), ...params }, { signal: ctx?.signal });
      const got = await this.applyAccess(chatId, { ask, flags }, answer, denied);
      granted.push(...got);
      // a grant the user gave while they had taken over the screen hands it back (#1902)
      if (got.length) await this.cu.resumeAfterCard(chatId);
    }
    const out = {
      granted: [...already, ...granted].map((a) => ({ app: a.name, bundleId: a.bundleId, tier: a.tier })),
      denied,
      clipboardRead: s.clipboardRead,
      clipboardWrite: s.clipboardWrite,
      systemKeyCombos: s.systemKeyCombos,
      screenControl: s.consent,
      tiers: 'read: screenshots only; click: left click and scroll only; full: everything',
    };
    if (teach) return this.startTeach(chatId, out, answer);
    if (always.length) out.alwaysAllowed = always;
    if (self) out.instead = `MoPilot: ${P.SELF_PANE_HINT}`;
    try {
      const missing = await this.missingPermissions(chatId, helper, ctx);
      if (missing.length) out.setup = missing.map((p) => onboarding(p, this.helperInfo)).join(' ');
    } catch (error) {
      // permission status unknown: no setup hint (a missing permission still fails the action with its guide)
      noteIgnored('check the macOS permissions for desktop control', error);
    }
    if (out.granted.length)
      out.next =
        'Work in an app in the background with desktop_app_screenshot and the other desktop_app_* tools; use desktop_open_application and desktop_screenshot only for display-scope control.';
    return [{ type: 'text', text: JSON.stringify(out, null, 1) }];
  }

  /**
   * The required macOS permissions still off once access is settled. The setup text says a permission card is in the
   * chat and macOS was asked, so both happen here, as for an action that failed: the card goes up, macOS is asked
   * (never with nobody there, or for a stopped call) and a grant given in time leaves nothing to set up. Empty when
   * no card goes up (a stopped call, the coordinator closing).
   * @this {DesktopControl}
   */
  async missingPermissions(chatId, helper, ctx) {
    const off = async () => {
      const perms = await helper.permissionStatus();
      return ['screenRecording', 'accessibility'].filter((p) => perms?.[p] === false);
    };
    const missing = await off();
    // a call stopped meanwhile (the access card can wait long) raises nothing for its ended turn
    if (!missing.length || !mayAct()) return [];
    // the order the card's own recheck names them in
    const permission = missing.includes('accessibility') ? 'accessibility' : 'screenRecording';
    const refusal = this.cu.showPermissionGuide(chatId, permission);
    if (!refusal) return [];
    if ((await this.cu.unattended(chatId, ctx)) || !this.cu.permissionMayAct(chatId, refusal)) return missing;
    // nothing missing now takes the card down; otherwise it stays on a permission still off, read again after the wait
    if ((await this.cu.awaitGrant(chatId, refusal, permission)) && (await this.cu.recheck(chatId))) return [];
    return off();
  }

  /**
   * What an answer to the access card grants: the apps picked (each at its tier, remembered for every chat on
   * "Always allow") and the clipboard and system-shortcut extras.
   * Apps not allowed go on `denied`. Returns the apps granted.
   * @param {string} chatId
   * @param {{ ask: Map<string, any>, flags: string[] }} req what the card asked for
   * @param {any} answer
   * @param {any[]} [denied]
   * @this {DesktopControl}
   */
  async applyAccess(chatId, req, answer, denied = []) {
    const s = this.session(chatId);
    const granted = [];
    const allow = answer?.decision === 'allow';
    const picked = allow && Array.isArray(answer.apps) ? new Set(answer.apps.map((x) => String(x).toLowerCase())) : null;
    for (const [k, a] of req.ask) {
      if (allow && (!picked || picked.has(k))) {
        s.apps.set(k, { bundleId: a.bundleId, name: a.name, tier: a.tier });
        granted.push(a);
      } else denied.push({ app: a.name, bundleId: a.bundleId, reason: 'the user did not allow it' });
    }
    // "Always allow": the apps (each at its tier) are remembered for every chat; "Allow in this chat": saved with
    // the chat, so Settings lists them and Remove there takes them back. The clipboard, whole-Mac shortcuts and
    // screen control are never saved and stay this chat's session
    const always = allow && answer.remember === true;
    for (const a of allow ? granted : []) {
      const app = { bundleId: a.bundleId, name: a.name };
      if (always) this.grants?.grant?.(null, app, TIER_LEVEL[a.tier], 'always');
      else {
        try {
          this.grants?.grant?.(chatId, app, TIER_LEVEL[a.tier], 'chat');
        } catch (error) {
          // unsaved: the chat still has the app for this session, as before
          noteIgnored('save an app allowed in this chat', error);
        }
      }
    }
    // screen control is the chat's takeover consent (desktopGate.cjs preflight)
    for (const f of req.flags) if (allow && answer[f] !== false) s[f === 'screenControl' ? 'consent' : f] = true;
    // an app hidden while this chat holds the desktop is shown again once it is granted
    await this.unhide(
      chatId,
      granted.map((a) => a.bundleId),
    );
    return granted;
  }

  /** @this {DesktopControl} */
  async listGranted(chatId) {
    const s = this.session(chatId);
    const g = [...this.granted(chatId).values()];
    let running = new Map();
    try {
      const helper = await this.ready();
      running = new Map(((await helper.listApps()).apps || []).map((a) => [String(a.bundleId).toLowerCase(), a]));
    } catch (error) {
      // running apps unknown: list grants without live state
      noteIgnored('list the running apps for the granted-apps list', error);
    }
    const apps = g.map((a) => {
      const r = running.get(a.bundleId.toLowerCase());
      return { app: a.name, bundleId: a.bundleId, tier: a.tier, running: !!r, frontmost: !!r?.frontmost };
    });
    return [
      {
        type: 'text',
        text: JSON.stringify(
          { apps, clipboardRead: s.clipboardRead, clipboardWrite: s.clipboardWrite, systemKeyCombos: s.systemKeyCombos },
          null,
          1,
        ),
      },
    ];
  }

  /**
   * The granted app a name or bundle id names, or null.
   * @this {DesktopControl}
   */
  findGranted(chatId, query) {
    const q = String(query || '')
      .trim()
      .toLowerCase();
    // an empty name would match every app's name below
    if (!q) return null;
    const g = this.granted(chatId);
    return (
      g.get(q) ||
      [...g.values()].find((a) => a.name.toLowerCase() === q) ||
      [...g.values()].find((a) => a.name.toLowerCase().includes(q)) ||
      null
    );
  }

  /** @this {DesktopControl} */
  async openApplication(chatId, args) {
    refuseSelf(args.app);
    const app = this.findGranted(chatId, args.app);
    if (!app) throw new ToolError(`${args.app} isn't granted in this chat; call desktop_request_access first`, 'denied');
    const helper = await this.ready();
    return this.serial(async () => {
      const r = await helper.openApp(app.bundleId, { bundleIds: [app.bundleId] });
      this.session(chatId).lastApp = app.bundleId;
      const record = P.actionRecord('open_application', r.frontmost ? 'confirmed' : 'unverifiable', 'global', {
        app: app.name,
        tier: app.tier,
        reason: r.frontmost ? undefined : 'the app did not come to the front yet',
      });
      return [{ type: 'text', text: JSON.stringify(record) }];
    });
  }

  /** @this {DesktopControl} */
  async switchDisplay(chatId, args) {
    const helper = await this.ready();
    const s = this.session(chatId);
    const displays = (await helper.listDisplays()).displays || [];
    const list = displays.map((d, i) => ({
      number: i + 1,
      id: d.id,
      name: d.name,
      main: !!d.main,
      points: `${d.width}x${d.height}`,
      scale: d.scale,
      current: (s.display ?? s.geom?.display) === d.id,
    }));
    if (args.display === undefined || args.display === null || args.display === '')
      return [{ type: 'text', text: JSON.stringify({ displays: list }, null, 1) }];
    const want = String(args.display).trim();
    // the list's number first (display ids are small numbers too: the built-in display is often id 1), then an id or a name
    const n = /^\d+$/.test(want) ? Number(want) : NaN;
    const d =
      (n >= 1 && n <= displays.length ? displays[n - 1] : null) ||
      displays.find((x) => String(x.id) === want || (x.name && String(x.name).toLowerCase() === want.toLowerCase()));
    if (!d) throw new ToolError(`No display ${want}; call desktop_switch_display without display to list them`, 'bad_args');
    s.display = d.id;
    s.geom = null;
    s.elements = [];
    return [
      {
        type: 'text',
        text: `Screenshots now show display ${list.find((x) => x.id === d.id).number} (${d.name || d.id}). Take a desktop_screenshot before acting there.`,
      },
    ];
  }

  /** @this {DesktopControl} */
  async readClipboard(chatId) {
    if (!this.session(chatId).clipboardRead)
      throw new ToolError('Reading the clipboard needs clipboardRead: call desktop_request_access with clipboardRead: true', 'denied');
    if (!this.clipboard) throw new ToolError('The clipboard is not available', 'unavailable');
    return [{ type: 'text', text: this.clipboard.readText() || '' }];
  }

  /** @this {DesktopControl} */
  async writeClipboard(chatId, args) {
    if (!this.session(chatId).clipboardWrite)
      throw new ToolError('Writing the clipboard needs clipboardWrite: call desktop_request_access with clipboardWrite: true', 'denied');
    if (!this.clipboard) throw new ToolError('The clipboard is not available', 'unavailable');
    this.writeOwn(await this.stashClipboard(chatId, this.clipboard), String(args.text ?? ''));
    return [{ type: 'text', text: JSON.stringify(P.actionRecord('write_clipboard', 'confirmed', 'global')) }];
  }

  /* -- the user's clipboard ----------------------------------------- */

  /**
   * Keeps the user's clipboard (all of it through the helper, else its text) before the tools first write it.
   * @param {string} chatId
   * @param {Clipboard} board the clipboard the tools write
   * @returns {Promise<Clip>} what is kept, for writeOwn()
   * @this {DesktopControl}
   */
  async stashClipboard(chatId, board) {
    // quitting already put the user's clipboard back: nothing writes it after that
    if (this.cu.closed) throw shuttingDown();
    if (this.clip) {
      this.clip.chats.add(chatId);
      return this.clip;
    }
    // its text is kept here too: the helper's copy (every type) is lost if the helper crashes or is stopped first
    /** @type {Clip} */
    const clip = { board, chats: new Set([chatId]), via: 'text', text: board.readText() || '', written: null };
    try {
      await this.helper.saveClipboard();
      clip.via = 'helper';
    } catch (error) {
      // the text kept above comes back instead
      noteIgnored("keep the user's whole clipboard in the helper", error);
    }
    this.clip = clip;
    return clip;
  }

  /**
   * Writes the clipboard for the tools, remembering what they wrote in what stashClipboard kept.
   * @param {Clip} clip
   * @param {string} text
   * @this {DesktopControl}
   */
  writeOwn(clip, text) {
    checkAct('writing the clipboard');
    clip.board.writeText(text);
    clip.written = text;
  }

  /**
   * The turn ended: the user's clipboard comes back once no chat that used it is still at it. Something
   * the user copied in the meantime stays.
   * @this {DesktopControl}
   */
  async restoreClipboard(chatId) {
    const clip = this.clip;
    if (!clip || !clip.chats.delete(chatId) || clip.chats.size) return;
    this.clip = null;
    const ours = clip.written === null || clip.board.readText() === clip.written;
    if (!ours && clip.via !== 'helper') return;
    if (clip.via === 'helper') {
      const r = await this.helper.restoreClipboard(ours).catch((error) => {
        // the helper stopped or crashed: its copy went with it, and the text kept here comes back below
        noteIgnored("put the user's clipboard back at the end of a turn", error);
        return null;
      });
      // a relaunched helper has no copy to put back (restored: false)
      if (!ours || r?.restored === true) return;
    }
    clip.board.writeText(clip.text);
  }
}

module.exports = { DesktopAccess };
