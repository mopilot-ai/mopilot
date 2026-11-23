// VM-only glue for the edge-case suite: one scenario on one cell of a MoPilot instance over CDP. It starts a chat,
// sends the prompt (and for a switch cell switches harness and sends the rest), answers MoPilot's confirmation cards
// as the operator, hands a hand-off back with "Done, continue" (never typing a password or code), crashes the tab when
// the scenario asks for it, and then clicks every action the UI offered and records what each click did.
import { answerOwnedApproval } from '../lib/mgb/approvalOwner.mjs';
import { phaseRecord } from '../lib/phase.mjs';
import { BACK_BUTTON, BACK_TO_APP } from '../lib/navigation.mjs';
import { writeFileSync } from 'node:fs';
import { DONE_CONTINUE } from '../../shared/doneContinue.mjs';
import { KEY_TARGET, pickedIn, switchConfirmed } from '../lib/edge.mjs';
import { ACCOUNT_BANNER_TEXT, classifyClick, isAccountBanner, skipReason } from '../lib/edgeOffers.mjs';
import { appWindow, browserTabs, session, targets } from './cdp.mjs';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const RUNNING = `!!document.querySelector('button.send-btn.stop')`;
const clickJs = (/** @type {string} */ sel, text = '') =>
  `(()=>{const els=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>${text ? `e.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})` : 'true'}); if(!els.length) return false; els[0].click(); return true;})()`;
// containers of the actions MoPilot offers the user: pane notices, chat strips, the agent bar, alerts
const OFFER_SCOPE = '.browser-notice, .elsewhere-notice, .browser-agent-bar, [role=alert]';
const OFFERS = `(()=>{const out=[]; for (const box of document.querySelectorAll(${JSON.stringify(OFFER_SCOPE)})) { if (box.closest('.approval-card')) continue;
  for (const b of box.querySelectorAll('button')) { if (b.disabled || !b.offsetParent) continue; const label=(b.innerText||b.getAttribute('aria-label')||'').trim(); if (!label) continue;
  out.push({label, where: box.className || box.getAttribute('role'), context: box.innerText.replace(/\\s+/g,' ').slice(0,200)}); } } return out; })()`;
// a harness account's expired sign-in banner is the VM's, not the scenario's: left out of the before/after snapshots
const NOT_ACCOUNT = `(e)=>!(e.classList.contains('acct-banner')&&new RegExp(${JSON.stringify(ACCOUNT_BANNER_TEXT)},'i').test(e.innerText))`;
const SNAP = `(()=>({alerts:[...document.querySelectorAll('[role=alert]')].filter(${NOT_ACCOUNT}).map(e=>e.innerText.trim()).filter(Boolean),
  notices:[...document.querySelectorAll(${JSON.stringify(OFFER_SCOPE)})].filter(${NOT_ACCOUNT}).map(e=>e.innerText.replace(/\\s+/g,' ').trim()).filter(Boolean),
  chatLength:(document.querySelector('main')?.innerText||'').length,
  view:!!${BACK_BUTTON}?'settings':'app',
  pane:(document.querySelector('.tb-tab.active')?.getAttribute('aria-label')||'')+(document.querySelector('.browser-stage')?.offsetParent?' (shown)':' (hidden)'),
  busy:[...document.querySelectorAll('button')].some(b=>/Connecting|…$/.test(b.innerText.trim())&&b.disabled)}))()`;
const DISMISSIVE = /^(dismiss|cancel|cancel window|close)$/i;

/** The cards whose Allow once sits in the primary's menu (src/components/thread/approvals/hostCards.tsx SageApprovalCard). */
const SCOPE_CARDS = ['browserOrigin', 'computerAccess', 'visionConsent'].map((k) => `.sage-approval[data-kind=${k}]`).join(',');

/**
 * Runs one scenario on one cell and returns the turn, the offered actions and their click results.
 * @param {{ port: string, cell: { harness: string, model: string, switchTo?: string, switchModel?: string },
 *   prompts: string[], timeoutS: number, crash: boolean, events: () => Promise<any[]>, shot: string, skipChrome?: boolean,
 *   switchAt?: number, answer?: (n: number, text: string, target?: { url: string, page: string } | null, token?: string) => string | Promise<string>, mode?: 'full' | 'ask', tick?: (ctx: any) => Promise<void> }} o
 * `skipChrome`: never click an action that goes to Chrome (a VM whose Chrome another run is using); recorded as skipped.
 * The 12-Grid Bench (bench/mgb-run.mjs) also passes:
 * - `switchAt`: the message the switch cell changes harness before (default 1);
 * - `answer(n, text)`: how the operator answers the n-th confirmation card (or a promise of it): 'allow' (the default), 'read-only' (picks
 *   the Read only access level, then allows) or 'deny';
 * - `mode`: the chat's permission mode before the first message ('full' or 'ask'; unset keeps the instance's);
 * - `tick(ctx)`: called on every poll of a turn with the message under way and when it was sent, to inject Esc or a
 *   crash at the right moment.
 */
export async function edgeTurn({
  port,
  cell,
  prompts,
  timeoutS,
  crash,
  events,
  shot,
  skipChrome = false,
  switchAt = 1,
  answer,
  mode,
  tick,
}) {
  const app = await appWindow(port);
  const ev = (/** @type {string} */ js) => app.evaluate(js);
  const until = async (/** @type {string} */ js, /** @type {number} */ ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await ev(js).catch(() => false)) return true;
      await sleep(500);
    }
    return false;
  };
  const sendKey = async (/** @type {string} */ k, code = 27) => {
    for (const type of ['keyDown', 'keyUp'])
      await app.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code });
  };
  // a key the scenario presses (Enter to send, Esc mid-turn) goes to whatever has the focus, as a person's does, and the
  // record says what that was: never focus the target first, which hid a composer that dropped the focus (#1658)
  const key = async (/** @type {string} */ k, code = 27) => {
    record.keys.push({ key: k, at: String(await ev(KEY_TARGET).catch(() => '')), t: Date.now() });
    await sendKey(k, code);
  };
  const approvalAnswers = new Map();
  const trustedClick = async (/** @type {{x: number, y: number}} */ r) => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await app.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    }
  };
  const tabCount = async () => (await browserTabs(port).catch(() => [])).length;
  const snap = async () => ({ ...(await ev(SNAP)), tabs: await tabCount(), events: (await events().catch(() => [])).length });
  /** opens the model menu and picks harness and model (three tries: a click right after a turn can be lost) */
  // the composer's model button, "Select model" on every harness (builds before #1319's label change read "Select harness"
  // on a basic one)
  const MODEL_BTN = '[aria-label="Select model"], [aria-label="Select harness"]';
  const modelSelection = async () =>
    (await ev(`(()=>{const b=document.querySelector(${JSON.stringify(MODEL_BTN)}); return {
      label:b?.querySelector('.model-name')?.textContent ?? '',
      harness:b?.querySelector('.harness-icon[aria-label]')?.getAttribute('aria-label') ?? ''
    };})()`)) ?? { label: '', harness: '' };
  const selected = async (harness, model) => {
    const s = await modelSelection();
    return pickedIn(s.label, harness, model, s.harness);
  };
  const pickModel = async (/** @type {string} */ harness, /** @type {string} */ model) => {
    for (let i = 0; i < 3; i++) {
      // a new chat keeps the last harness: one already on it needs no picking
      if (await selected(harness, model)) return true;
      await ev(clickJs(MODEL_BTN));
      await until(clickJs('[aria-label="Select harness and model"]'), 5000);
      await until(clickJs('.hp-harnesses .hp-row', harness), 5000);
      await sleep(500);
      if (await until(clickJs('.hp-models .menu-item', model), 5000)) return true;
      // an ACP harness row picks its default model and closes the picker: nothing to click, already picked
      if (await selected(harness, model)) return true;
      for (let k = 0; k < 3; k++) await sendKey('Escape');
      await sleep(1000);
    }
    return false;
  };

  const record = {
    approvals: 0,
    approvalLog: /** @type {string[]} */ ([]),
    asked: false,
    askLog: /** @type {string[]} */ ([]),
    offeredDuringTurn: /** @type {any[]} */ ([]),
    phases: /** @type {any[]} */ ([]),
    crashed: false,
    strips: /** @type {string[]} */ ([]),
    switch: /** @type {any} */ (null),
    keys: /** @type {{ key: string, at: string, t: number }[]} */ ([]),
  };
  let captured = false;
  /** the app window as the turn left it (a debugging aid only) */
  const capture = async () => {
    captured = true;
    try {
      const png = await app.send('Page.captureScreenshot', { format: 'png' }, 15000);
      writeFileSync(shot, Buffer.from(png.result.data, 'base64'));
    } catch {
      // no screenshot: the record still has the chat text
    }
  };
  /** @type {any[]} every click on an offered action and what it did */
  const offered = [];
  const same = (/** @type {any} */ a, /** @type {any} */ b) => a.label === b.label && a.where === b.where;
  const noteOffers = async () => {
    const now = /** @type {any[]} */ ((await ev(OFFERS).catch(() => [])) ?? []).filter((o) => !isAccountBanner(o));
    for (const o of now) {
      if (!record.offeredDuringTurn.some((x) => same(x, o))) record.offeredDuringTurn.push({ ...o, since: Date.now() });
    }
    return now;
  };
  /**
   * Clicks one offered action and records what it did. Mid-turn the agent also changes the chat, so only errors and
   * the pane's own state count there.
   */
  const clickOffer = async (/** @type {any} */ o, midTurn = false) => {
    const before = await snap();
    const clicked = await ev(
      `(()=>{for (const box of document.querySelectorAll(${JSON.stringify(OFFER_SCOPE)})) { if ((box.className||box.getAttribute('role')) !== ${JSON.stringify(o.where)}) continue;
        const b=[...box.querySelectorAll('button')].find(x=>(x.innerText||x.getAttribute('aria-label')||'').trim()===${JSON.stringify(o.label)}); if (b && !b.disabled) { b.click(); return true; } } return false; })()`,
    );
    await sleep(4000);
    let after = await snap();
    if (after.busy) {
      await sleep(8000);
      after = await snap();
    }
    if (midTurn) after.chatLength = before.chatLength;
    const verdict = clicked ? classifyClick(before, after) : { result: 'withdrawn', detail: 'gone before it could be clicked' };
    // an action that started a new turn after the task (e.g. "Continue task in Chrome", "Resume"): let it run, then stop it
    if (!midTurn && (await ev(RUNNING).catch(() => false))) {
      await until(`!${RUNNING}`, 90000);
      await ev(clickJs('button.send-btn.stop')).catch(() => false);
      verdict.detail += '; started a turn';
    }
    if (after.view === 'settings') await ev(BACK_TO_APP);
    const tail = String((await ev(`document.querySelector('main')?.innerText.slice(-300)`).catch(() => '')) ?? '');
    offered.push({ ...o, ...verdict, midTurn, tail });
  };

  // one message: send, then watch until the turn ends
  const runTurn = async (/** @type {string} */ prompt) => {
    const t0 = Date.now();
    await ev(`document.querySelector('[aria-label=Message]').focus()`);
    await app.send('Input.insertText', { text: prompt });
    await sleep(300);
    // sent the way a person sends it, so the focus is where the app leaves it for the next key
    await key('Enter', 13);
    const started = await until(RUNNING, 30000);
    let ended = false;
    let idle = 0;
    let signinSince = 0;
    const end = t0 + timeoutS * 1000;
    while (started && Date.now() < end) {
      // a pane notice (passkey wait, popup, page error) that stays up 3 s: click its remedies as a stuck user would,
      // the Chrome hand-off first
      const live = (await noteOffers()).filter((o) => o.where.startsWith('browser-notice') && !offered.some((x) => same(x, o)));
      const due = live.filter(
        (o) =>
          // the same refusals as the end of the turn: the system browser, account sign-in, Chrome when it is skipped
          !skipReason(o, skipChrome) && Date.now() - (record.offeredDuringTurn.find((x) => same(x, o))?.since ?? Date.now()) >= 3000,
      );
      const pick = due.find((o) => /chrome/i.test(o.label)) ?? due.find((o) => !DISMISSIVE.test(o.label));
      if (pick) {
        await clickOffer(pick, true);
        continue;
      }
      if (crash && !record.crashed && (await events()).some((e) => e.event === 'loaded')) {
        const t = (await targets(port)).find((x) => x.url.includes('/s/crash'));
        if (t) {
          const s = await session(t.webSocketDebuggerUrl);
          // Page.crash never answers: the renderer is gone
          await s.send('Page.crash', {}, 2000).catch(() => null);
          s.close();
          record.crashed = true;
        }
      }
      // the message under way is the next phase; t0 is when it was sent
      if (tick) await tick({ ev, app, key, trustedClick, record, message: record.phases.length, messageStartedAt: t0 });
      // each card counts once (marked when first seen) and is answered until it goes: its allow button, or the primary one.
      // A site or app card (Claude Desktop's layout) keeps Allow once in its chevron's menu: the chevron, then that item.
      const card = await ev(
        `(()=>{const c=document.querySelector('.approval-card'); if(!c) return null; const actionTarget=JSON.parse(c.querySelector('[data-action-target]')?.dataset.actionTarget||'null'); const token=c.dataset.edgeToken||(c.dataset.edgeToken=crypto.randomUUID()); const fresh=!c.dataset.edgeSeen; c.dataset.edgeSeen='1'; const q=c.classList.contains('question-card');
          const scoped=c.matches(${JSON.stringify(SCOPE_CARDS)})&&c.querySelector('.ap-split .chevron');
          const once=scoped&&[...document.querySelectorAll('.popover-layer [role=menuitem]')].find(x=>/^Allow once/.test(x.innerText.trim()));
          const b=q?[...c.querySelectorAll('button')].find(x=>/^skip/i.test(x.innerText.trim())):(once||scoped||c.querySelector('.ap-btn.allow')||c.querySelector('.btn.primary')); if(!b) return {q, fresh, token, actionTarget, text:c.innerText.slice(0,1200)};
          b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); return {q, fresh, token, actionTarget, x:r.x+r.width/2, y:r.y+r.height/2, text:c.innerText.slice(0,1200)}})()`,
      ).catch(() => null);
      if (card) {
        // a card counted already is only answered again (a missed click)
        if (card.fresh && card.q) {
          record.asked = true;
          record.askLog.push(`question: ${card.text}`);
        } else if (card.fresh) {
          record.approvals++;
          record.approvalLog.push(card.text);
        }
        const how = await answerOwnedApproval(card, {
          answers: approvalAnswers,
          answer,
          number: record.approvals - 1,
          ev,
          click: trustedClick,
          scopeCards: SCOPE_CARDS,
        });
        if (card.fresh && !card.q && how !== 'allow') (record.answers ??= []).push(how);
        idle = 0;
        await sleep(1500);
        continue;
      }
      // the agent handed the tab to the user: wait as a person would, then give it back without typing anything
      // a sign-in sheet (browser_request_credentials): the user is asked; after 10 s the driver picks "I'll sign in
      // myself" as a person who types the code on the page would, and never fills the sheet
      const sheet = await ev(`document.querySelector('.credential-sheet')?.innerText.replace(/\\s+/g,' ').slice(0,200) ?? null`).catch(
        () => null,
      );
      if (sheet) {
        if (!record.askLog.some((l) => l.startsWith('credentials'))) record.askLog.push(`credentials: ${sheet}`);
        record.asked = true;
        signinSince ||= Date.now();
        if (Date.now() - signinSince > 10000) {
          const label = await ev(
            `(()=>{const b=[...document.querySelectorAll('.credential-sheet .credential-actions button')].find(x=>/myself/i.test(x.innerText)); b?.click(); return b?.innerText ?? null})()`,
          );
          offered.push({
            label: label ?? "I'll sign in myself",
            where: 'credential-sheet',
            result: label ? 'worked' : 'withdrawn',
            detail: 'driver answered the sheet',
            midTurn: true,
          });
          signinSince = 0;
        }
        await sleep(1000);
        continue;
      }
      // strips above the composer say why the agent handed over; "tookOver" is the user taking over, which the driver never does
      for (const s of (await ev(
        `[...document.querySelectorAll('.handoff-strip')].map(e=>(e.dataset.reason||'')+': '+e.innerText.replace(/\\s+/g,' ').slice(0,160))`,
      ).catch(() => [])) ?? []) {
        if (!record.strips.includes(s)) record.strips.push(s);
      }
      const signin = await ev(
        `[...document.querySelectorAll('.handoff-strip:not([data-reason=tookOver]), .browser-agent-bar')].map(e=>e.innerText).find(t=>/sign in|your turn on|CAPTCHA|Confirm the payment|Finish the step/i.test(t)) ?? null`,
      ).catch(() => null);
      if (signin) {
        if (!record.askLog.some((l) => l.startsWith('handover')))
          record.askLog.push(`handover: ${signin.replace(/\s+/g, ' ').slice(0, 200)}`);
        record.asked = true;
        signinSince ||= Date.now();
        if (Date.now() - signinSince > 10000) {
          await noteOffers();
          await ev(clickJs('.handoff-strip button, .browser-agent-bar button', DONE_CONTINUE));
          signinSince = 0;
        }
        // the hand-off ended the agent's turn (#1834): the chat stays idle until Done starts the next one, so idle doesn't
        // count until the driver has handed back; after that an idle chat ends the scenario as before
        if (signinSince) {
          await sleep(1000);
          continue;
        }
      }
      if (!(await ev(RUNNING).catch(() => true))) {
        if (++idle >= 3) {
          ended = true;
          break;
        }
      } else idle = 0;
      await sleep(1000);
    }
    const phase = phaseRecord(t0, Date.now(), started, ended);
    if (!ended) await ev(clickJs('button.send-btn.stop')).catch(() => false);
    await sleep(1500);
    return phase;
  };

  try {
    await ev(BACK_TO_APP);
    await ev('document.activeElement?.blur?.()');
    await sleep(500);
    await ev(`[...document.querySelectorAll('button,a,[role=button]')].find(b=>b.innerText.trim().startsWith('New chat'))?.click()`);
    if (!(await until(`[...document.querySelectorAll('h1,h2,h3')].some(h=>h.innerText.includes('What should we build?'))`, 15000))) {
      return { driverError: true, error: 'no home view' };
    }
    if (!(await pickModel(cell.harness, cell.model ?? '')))
      return { driverError: true, error: `model not found: ${cell.harness} ${cell.model}` };
    // New-chat selection must settle before sending. Existing-chat switches instead require the sheet below.
    const selectionDeadline = Date.now() + 5000;
    while (!(await selected(cell.harness, cell.model ?? ''))) {
      if (Date.now() >= selectionDeadline) return { driverError: true, error: `selection did not settle: ${cell.harness} ${cell.model}` };
      await sleep(100);
    }
    const model = (await modelSelection()).label;
    if (mode) {
      // "Change mode" on a basic (ACP) harness, whose modes carry the same permission classes
      await ev(clickJs('[aria-label="Change permissions"], [aria-label="Change mode"]'));
      const row = mode === 'ask' ? 'default' : 'full-access';
      if (!(await until(clickJs(`.perm-item.${row}`), 5000))) return { driverError: true, error: `permission mode not found: ${mode}` };
      await sleep(500);
    }
    for (const [i, prompt] of prompts.entries()) {
      if (i === switchAt && cell.switchTo) {
        const t = Date.now();
        const found = await pickModel(cell.switchTo, cell.switchModel ?? '');
        const sheetUp = await until(`!!document.querySelector('.switch-sheet')`, 5000);
        const sheet = sheetUp ? await ev(`document.querySelector('.switch-sheet').innerText`) : null;
        const clicked = sheetUp ? !!(await ev(clickJs('.switch-sheet .btn.primary', 'Switch'))) : false;
        // Confirm the accepted next-message selection, not backend completion (which happens on send).
        let after = '',
          afterHarness = '';
        let confirmed = false,
          quick = false;
        const deadline = Date.now() + 10000;
        do {
          const selection = await modelSelection();
          after = selection.label;
          afterHarness = selection.harness;
          const sheetGone = !(await ev(`!!document.querySelector('.switch-sheet')`));
          ({ confirmed, quick } = switchConfirmed({
            sheetUp,
            clicked,
            found,
            after,
            afterHarness,
            switchTo: cell.switchTo,
            switchModel: cell.switchModel ?? '',
            sheetGone,
          }));
          if (confirmed) break;
          await sleep(100);
        } while (Date.now() < deadline);
        record.switch = {
          found,
          sheetUp,
          confirmed,
          quick,
          sheet,
          after,
          afterHarness,
          ms: Date.now() - t,
        };
        // the first part already ran: graded as far as it got, with the reason
        if (!confirmed) return { ...record, error: 'the switch did not go through', endedAt: Date.now() };
      }
      const p = await runTurn(prompt);
      record.phases.push(p);
      if (!p.started) return { ...record, driverError: i === 0, error: 'the turn did not start within 30 s', endedAt: Date.now() };
    }
    await ev(`[...document.querySelectorAll('main button.worked-for')].forEach(e=>e.click())`).catch(() => false);
    await sleep(1000);
    const endedAt = Date.now();
    const main = String((await ev(`document.querySelector('main')?.innerText ?? ''`)) ?? '');
    // the agent's answer: what the chat shows after the last prompt (the prompt itself names the page and the task)
    const tail = /** @type {string} */ (prompts.at(-1)).slice(-60);
    const answer = main.slice(main.lastIndexOf(tail) + tail.length).slice(-4000);
    // questions the agent ended its turn with, in a form under its reply (AsyncQuestions): never answered here
    const replyQuestions = /** @type {string[]} */ (
      (await ev(`[...document.querySelectorAll('main .async-questions .question-text')].map(q=>q.innerText.trim().slice(0,200))`).catch(
        () => [],
      )) ?? []
    );
    // a step the agent handed to the user as its turn ended (a strip that came up after the last look during the turn)
    const handoffs = /** @type {string[]} */ (
      (await ev(
        `[...document.querySelectorAll('.handoff-strip:not([data-reason=tookOver])')].map(e=>e.innerText.replace(/\\s+/g,' ').trim().slice(0,160))`,
      ).catch(() => [])) ?? []
    );

    await capture();
    // click every action the UI still offers, remedies first and dismissals last, re-reading after each click
    for (let n = 0; n < 10; n++) {
      const now = /** @type {any[]} */ ((await ev(OFFERS).catch(() => [])) ?? []).filter(
        (o) => !isAccountBanner(o) && !offered.some((x) => same(x, o)),
      );
      if (!now.length) break;
      const skip = now.find((x) => skipReason(x, skipChrome));
      if (skip) {
        offered.push({ ...skip, result: 'skipped', detail: skipReason(skip, skipChrome) });
        continue;
      }
      await clickOffer(now.find((x) => !DISMISSIVE.test(x.label)) ?? now[0]);
    }
    for (const o of record.offeredDuringTurn) {
      if (!offered.some((x) => same(x, o))) offered.push({ ...o, result: 'withdrawn', detail: 'gone before the turn ended' });
    }
    const timedOut = record.phases.some((p) => !p.ended);
    return {
      ...record,
      ok: !timedOut,
      timedOut,
      model,
      wallMs: record.phases.reduce((s, p) => s + p.wallMs, 0),
      answer,
      replyQuestions,
      handoffs,
      endedAt,
      offered,
      shot,
    };
  } catch (e) {
    const error = String(/** @type {Error} */ (e).message).slice(0, 300);
    return { ...record, driverError: !record.phases.length, error, endedAt: Date.now(), offered };
  } finally {
    if (!captured) await capture();
    // leave the next run a clean pane: close this run's browser tabs
    await ev(
      `[...document.querySelectorAll('.tb-tab[title] .tb-tab-close')].filter(b=>/https?:/.test(b.closest('.tb-tab').title)).forEach(b=>b.click())`,
    ).catch(() => false);
    app.close();
  }
}
