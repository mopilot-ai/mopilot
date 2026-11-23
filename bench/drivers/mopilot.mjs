// Drives one MoPilot turn over the instance's CDP port: a new chat on the arm's harness and model, the prompt, the
// operator's trusted click on any confirmation card, then waits for the turn to end and reads the chat view.
import { BACK_TO_APP } from '../lib/navigation.mjs';
import { readActivity } from '../lib/transcript.mjs';
import { appWindow } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A page expression that clicks the first element matching sel (and containing text) and says whether it did. */
const clickJs = (/** @type {string} */ sel, /** @type {string} */ text = '') =>
  `(()=>{const els=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>${text ? `e.innerText.includes(${JSON.stringify(text)})` : 'true'}); if(!els.length) return false; els[0].click(); return true;})()`;
const RUNNING = `!!document.querySelector('button.send-btn.stop')`;
const APPROVAL = `(()=>{const b=document.querySelector('.approval-card .ap-btn.allow'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,text:b.closest('.approval-card')?.innerText.slice(0,200)}})()`;

/**
 * Runs one turn and reports it.
 * @param {{ port: string, harness: string, model: string, timeoutS: number, prompt: string }} o
 */
export async function mopilotTurn({ port, harness, model, timeoutS, prompt }) {
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
  let sent = false;
  try {
    // a fresh chat from the home view (leave Settings first: an agent's key presses can open it)
    await ev(BACK_TO_APP);
    await ev('document.activeElement?.blur?.()');
    await sleep(500);
    await ev(`[...document.querySelectorAll('button,a,[role=button]')].find(b=>b.innerText.trim().startsWith('New chat'))?.click()`);
    if (!(await until(`[...document.querySelectorAll('h1,h2,h3')].some(h=>h.innerText.includes('What should we build?'))`, 15000))) {
      throw new Error('no home view');
    }
    // picking a model closes the picker; with no model the instance's current harness and model are used
    if (model) {
      await ev(clickJs('[aria-label="Select model"]'));
      await until(clickJs('[aria-label="Select harness and model"]'), 5000);
      if (!(await until(clickJs('.hp-harnesses .hp-row', harness), 5000))) throw new Error(`harness not found: ${harness}`);
      await sleep(500);
      if (!(await until(clickJs('.hp-models .menu-item', model), 5000))) throw new Error(`model not found: ${model}`);
      await sleep(500);
    }
    const label = await ev(`document.querySelector('[aria-label="Select model"]')?.innerText`);

    const t0 = Date.now();
    await ev(`document.querySelector('[aria-label=Message]').focus()`);
    await app.send('Input.insertText', { text: prompt });
    await sleep(300);
    await ev(clickJs('[aria-label=Send]'));
    sent = true;
    let approvals = 0;
    const started = await until(RUNNING, 30000);
    let ok = started;
    if (ok) {
      const end = t0 + timeoutS * 1000;
      ok = false;
      let idle = 0;
      while (Date.now() < end) {
        // MoPilot confirms irreversible actions even in Full access; the operator approves with a trusted click
        const card = await ev(APPROVAL).catch(() => null);
        if (card) {
          for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
            await app.send('Input.dispatchMouseEvent', { type, x: card.x, y: card.y, button: 'left', clickCount: 1 });
          }
          approvals++;
          idle = 0;
          await sleep(1500);
          continue;
        }
        // three idle polls in a row: the turn has ended (this adds about 2-3 s to the measured wall time)
        if (!(await ev(RUNNING).catch(() => true))) {
          if (++idle >= 3) {
            ok = true;
            break;
          }
        } else idle = 0;
        await sleep(1000);
      }
    }
    const wallMs = Date.now() - t0;
    if (!ok) await ev(clickJs('button.send-btn.stop')).catch(() => false); // stop the turn so the next task starts clean
    await sleep(1500);
    const worked = `[...document.querySelectorAll('main button.worked-for')]`;
    await until(`${worked}.length>0`, 6000);
    await ev(`${worked}.forEach(e=>e.click())`).catch(() => false);
    await sleep(1500);
    const main = String((await ev(`document.querySelector('main')?.innerText ?? ''`)) ?? '');
    // a turn that never started is a driver failure, not a slow agent
    const error = started ? undefined : 'the turn did not start within 30 s';
    return { ok, error, driverError: !started, wallMs, approvals, model: label, answer: main.slice(-4000), ...readActivity(main) };
  } catch (e) {
    // a failure before the prompt went out is the driver's (no home view, harness or model missing); after it, the app's
    throw Object.assign(e, { beforeSend: !sent });
  } finally {
    app.close();
  }
}
