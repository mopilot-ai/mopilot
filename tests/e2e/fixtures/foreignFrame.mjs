// The foreign-frame repro's readiness handshake: query the exact page, prove MoPilot's debugger is attached, then trigger the fixture.
export async function injectForeignFrame(url, chrome = globalThis.chrome) {
  const tabs = (await chrome.tabs.query({})).filter((tab) => tab.url === url);
  if (tabs.length !== 1) return null;
  const tabId = tabs[0].id;
  try {
    const reply = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'document.documentElement.dataset.mopilotFrameReady',
      returnByValue: true,
    });
    if (reply?.result?.value !== 'true') return null;
  } catch {
    return null;
  }
  // The induced detach can reject the command that induced it. The caller must still require the real native event.
  const eventOffset = globalThis.__detached?.length ?? 0;
  let triggerError = '';
  try {
    const reply = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression:
        '(() => { if (document.documentElement.dataset.mopilotFrameReady !== "true") return false; document.dispatchEvent(new Event("mopilot-test-frame")); return true; })()',
      returnByValue: true,
    });
    if (reply?.result?.value !== true) return null;
  } catch (error) {
    triggerError = String(error);
  }
  return { tabId, triggerError, eventOffset };
}

/** Close only the fixture's inline menu before testing ownership recovery.
 * @param {{ getElementById: (id: string) => { remove(): void } | null }} document */
export function dismissForeignFrame(document = globalThis.document) {
  const frame = document.getElementById('injected-menu');
  if (!frame) return false;
  frame.remove();
  return true;
}
