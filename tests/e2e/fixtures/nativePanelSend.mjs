// Native panel sends admit one unchanged draft through its original composer only when it can accept it.
import { randomUUID } from 'node:crypto';
/** @param {{ inPanel: (expression: string) => Promise<any>, delay?: (ms: number) => Promise<unknown> }} o @param {string} text */
export async function submitNativePanel({ inPanel, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }, text) {
  const token = randomUUID();
  await inPanel(
    `(() => {
      const t = document.getElementById('text');
      const form = document.getElementById('composer');
      if (!t || !form) throw new Error('The native panel composer is unavailable.');
      const key = Symbol.for('mopilot.native-panel-send');
      const state = document[key] ??= { revision: 0 };
      if (chrome.runtime.sendMessage !== state.wrapped) {
        const send = chrome.runtime.sendMessage;
        state.wrapped = chrome.runtime.sendMessage = function(...args) {
          if (args[0]?.type === 'panelBind') state.revision++;
          return Reflect.apply(send, this, args);
        };
      }
      state.operation = { token: ${JSON.stringify(token)}, revision: state.revision, input: t, form };
      t.value = ${JSON.stringify(text)};
      t.dispatchEvent(new Event('input'));
    })()`,
  );
  for (let attempt = 0; attempt < 300; attempt++) {
    const admitted = await inPanel(`(() => {
      const t = document.getElementById('text');
      const form = document.getElementById('composer');
      const send = document.getElementById('send');
      const state = document[Symbol.for('mopilot.native-panel-send')];
      const op = state?.operation;
      if (!op || op.token !== ${JSON.stringify(token)} || op.revision !== state.revision ||
          (t && t !== op.input) || (form && form !== op.form)) return 'replaced';
      const visible = (el) => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
      if (t && t.value !== ${JSON.stringify(text)}) return 'changed';
      if (!visible(t) || t.disabled || !visible(form) || !visible(send) || send.disabled) return false;
      form.requestSubmit();
      return true;
    })()`);
    if (admitted === true) return;
    if (admitted === 'replaced') throw new Error('The native panel composer changed before submission.');
    if (admitted === 'changed') throw new Error('The native panel draft changed before submission.');
    await delay(100);
  }
  throw new Error('The native panel composer did not become ready for submission.');
}
