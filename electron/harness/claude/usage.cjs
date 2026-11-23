// A bounded, disposable CLI query shared by the profile usage reader and identity driver.
const { clock } = require('../../platform/ports/clock.cjs');
const { contentBlocks } = require('../../../shared/contentBlocks.mjs');
const { isSyntheticAssistant } = require('../../../shared/claudeItems/failures.mjs');
const { noteIgnored } = require('../../ignored.cjs');
/**
 * The CLI's /usage text. `hold`, when given, is awaited before the CLI closes: work the CLI started on its own (the
 * profile fetch electron/harness/claude/loginIdentity.cjs waits for) gets to finish.
 * @param {() => Promise<any>} sdk @param {any} options @param {number} [timeoutMs] @param {() => Promise<void>} [hold]
 */
async function readUsage(sdk, options, timeoutMs = 20000, hold) {
  let q;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = clock.setTimeout(() => reject(new Error('Timed out reading Claude Code usage')), timeoutMs);
  });
  const read = async () => {
    const { query } = await sdk();
    // The SDK may finish loading after the deadline. Do not start a query then.
    if (!timer) return '';
    q = query({ prompt: '/usage', options });
    let text = '';
    for await (const m of q) {
      if (m.type === 'result') {
        if (m.is_error) throw new Error(String(m.result ?? m.errors?.join('; ') ?? 'Claude Code could not read usage'));
        return String(m.result ?? '').trim() ? String(m.result) : text;
      }
      // the CLI's own error reply (an account at its limit) is no usage text
      if (m.type === 'assistant' && !isSyntheticAssistant(m))
        for (const b of contentBlocks(m.message?.content)) if (b.type === 'text') text += b.text;
    }
    return text;
  };
  try {
    return await Promise.race([read(), timeout]);
  } finally {
    clock.clearTimeout(timer);
    timer = null;
    if (q && hold) await hold();
    try {
      q?.close();
    } catch (error) {
      // the query may already be closed
      noteIgnored('close the Claude Code usage query', error);
    }
  }
}

module.exports = { readUsage };
