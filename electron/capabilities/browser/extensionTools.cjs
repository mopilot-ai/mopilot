// Harness-neutral Playwright extension tools with site permissions and cancellation guards.
const { noteIgnored } = require('../../ignored.cjs');
const { contentBlocks } = require('../../../shared/contentBlocks.mjs');
const { ToolError } = require('../contract/registry.cjs');
const { explained } = require('./refusals.cjs');
const { isBlank } = require('./origins.cjs');
const { chromeActionCheck, textOf } = require('./chromeIntent.cjs');
const { guarded, unguarded } = require('../contract/actionGuard.cjs');
const { NEEDS, sageName, pageUrl, modalStates, modalNote } = require('./extensionResults.cjs');
const { VENDOR_SOURCES, vendorErrorByWording } = require('../../../shared/vendorErrors.mjs');

/** Pages a result may land on without a site permission: blank tabs. */
const isNewTab = (url) => isBlank(url) || url === 'chrome://newtab/' || url === 'chrome://new-tab-page/';

/**
 * Playwright MCP's text for a Chrome profile without the Playwright Extension (vendorErrors.mjs, #1319 G21) reads as
 * Your Chrome not set up, with what the user does next, never as Playwright's own sentence about its environment.
 */
function notSetUp(/** @type {string} */ text) {
  if (vendorErrorByWording(text, VENDOR_SOURCES.yourChrome)?.row.kind === 'chromeExtensionMissing')
    throw new ToolError(
      "Your Chrome isn't set up: the Playwright Extension isn't installed in the Chrome profile MoPilot uses.",
      'not_installed',
    );
}

/**
 * Registry definitions for the Playwright tools, each behind the site permission it needs.
 * @param {{ channel: InstanceType<typeof import('./extension.cjs').ChromeChannel>, grants: InstanceType<typeof import('./origins.cjs').OriginGrants>, schemas: any[], enabled?: () => boolean }} o
 */
function chromeTools({ channel, grants, schemas, enabled = () => true }) {
  return schemas
    .filter((s) => sageName(s.name))
    .map((s) => {
      const need = NEEDS[s.name];
      return {
        name: sageName(s.name),
        description: `${s.description || ''} (Runs in the user's own Chrome, in a tab group for this chat.)`.trim(),
        schema: s.inputSchema && s.inputSchema.type === 'object' ? s.inputSchema : { type: 'object', properties: {} },
        policy: need === 'write' ? 'act' : 'observe',
        authorizesItself: true,
        handler: async (args, ctx) => {
          if (!enabled()) throw new ToolError('Browser control is turned off.', 'disabled');
          const inst = await channel.instance(ctx.chatId);
          if (args && typeof args.url === 'string') await grants.require(args.url, 'read', ctx);
          // answering a dialog is the one thing that works while it is open: no snapshot first (Playwright refuses one then)
          const modal = s.name === 'browser_handle_dialog';
          if (need === 'write') {
            if (inst.needsSnapshot && !modal)
              throw new ToolError(
                'Take a fresh Chrome snapshot before continuing after the browser handoff or a page change.',
                'page_changed',
              );
            // The user may have signed in or switched tabs since the last agent call.
            // Refresh before authorizing a write, and recheck after a possible permission prompt.
            const previous = inst.url;
            const fresh = modal ? null : await inst.call('browser_snapshot', {});
            const current = fresh ? pageUrl(fresh.content) : previous;
            const blocked = fresh ? modalStates(fresh.content) : [];
            if (blocked.length) throw new ToolError(modalNote(blocked), 'modal_open');
            if (fresh?.isError) notSetUp(textOf(fresh.content));
            if (fresh?.isError || !current)
              throw new ToolError('Take a fresh snapshot so MoPilot knows which Chrome page this is.', 'bad_args');
            if (previous && previous !== current) {
              inst.needsSnapshot = true;
              throw new ToolError('The Chrome page changed. Take a fresh snapshot before continuing.', 'page_changed');
            }
            if (!isNewTab(current)) {
              await grants.require(current, 'write', ctx);
              // the in-app browser's checks: no typing into a password field; a high-risk site asks for each action,
              // and a sensitive click, submit, form fill or dialog accept asks anywhere (in Full access only payment
              // details and password changes do, as in the in-app browser: OriginGrants.act). A dialog answer reads the
              // dialog from the modal state Chrome last reported (it can take no snapshot while the dialog is open)
              const seen = modal ? (inst.modalStates ?? []).map((m) => `- [${m.description}]`).join('\n') : textOf(fresh.content);
              const check = await chromeActionCheck(inst, s.name, args, seen);
              if (check.password)
                throw new ToolError(
                  'This is a password field: agents never type passwords. Ask the user to sign in themselves in their Chrome.',
                  'password_field',
                );
              if (check.botCheck) throw check.botCheck;
              const element = typeof args?.element === 'string' ? args.element : '';
              const asked = await grants.act(current, ctx, {
                tool: s.name.replace(/^browser_/, ''),
                summary: `${s.name.replace(/^browser_/, '').replace(/_/g, ' ')}${element ? ` "${element.slice(0, 100)}"` : ''}`,
                sensitive: check.sensitive,
                taint: check.taint,
              });
              if (asked && check.taint) {
                const now = await chromeActionCheck(inst, s.name, args, seen);
                if ((now.taint?.to ?? '') !== check.taint.to)
                  throw new ToolError('The form destination changed while you answered. Take a fresh snapshot.', 'page_changed');
              }
            }
            const check = modal ? null : await inst.call('browser_snapshot', {});
            if (check && (check.isError || pageUrl(check.content) !== current)) {
              inst.needsSnapshot = true;
              throw new ToolError('The Chrome page changed while waiting for permission. Take a fresh snapshot.', 'page_changed');
            }
          }
          if (!enabled())
            throw new ToolError('The selected browser changed. Take a fresh snapshot in the current browser.', 'page_changed');
          let r = await inst.call(s.name, args);
          // a file chooser is cancelled the way the built-in browser's is: handle_dialog with accept false
          const chooser = modal && r.isError && modalStates(r.content).find((m) => m.tool === 'browser_file_upload');
          if (chooser) {
            if (args?.accept) throw new ToolError(modalNote([chooser]), 'modal_open');
            r = await inst.call('browser_file_upload', {});
          }
          const landed = pageUrl(r.content);
          // nothing from a page goes back to the agent until its site is allowed
          if (landed && !isNewTab(landed)) {
            try {
              await grants.require(landed, 'read', ctx);
            } catch (e) {
              // it gives the page back, so it runs for a stopped call too
              await unguarded(() => inst.call('browser_navigate', { url: 'about:blank' })).catch((error) => {
                // best effort: leave the page; the permission error below is what the caller sees
                noteIgnored('leave a page the user did not allow (Your Chrome)', error);
              });
              throw e;
            }
          }
          const text = contentBlocks(r.content)
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
          const open = modalStates(r.content);
          // what Chrome shows now: a dialog answer reads it (chromeIntent), as it can take no snapshot then
          inst.modalStates = open;
          // Playwright names its own tools; the agent is told what to call here
          const blockedBy = open.length > 0 && !modal;
          if (r.isError && !blockedBy) notSetUp(text);
          if (r.isError)
            throw new ToolError(blockedBy ? modalNote(open) : text || 'Playwright MCP error', blockedBy ? 'modal_open' : 'failed');
          if (s.name === 'browser_snapshot' || s.name === 'browser_navigate') inst.needsSnapshot = false;
          return { content: [...contentBlocks(r.content), ...(open.length ? [{ type: 'text', text: modalNote(open) }] : [])] };
        },
      };
    })
    .map((tool) => ({
      ...tool,
      handler: (args, ctx) => {
        // a security refusal reads as the built-in browser's does: a stable reason, whether retrying can help, and what to do next,
        // and once the call is stopped, nothing more of it reaches Chrome (PlaywrightInstance.call)
        const run = () => explained(tool.handler(args, ctx), 'chrome');
        // the chat's instance stays while a call and the cards it waits on are in flight (a stopped call no longer counts)
        const signal = ctx?.signal ?? null;
        return guarded({ signal }, () => (typeof channel.hold === 'function' ? channel.hold(ctx.chatId, run, signal) : run()));
      },
    }));
}

module.exports = { chromeTools };
