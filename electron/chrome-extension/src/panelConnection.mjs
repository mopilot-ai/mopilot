// Connection states and composer placeholders for the Chrome side panel, independent of the tab’s chat and draft.
/** The message box's line before anything is typed: a new chat's, or a follow-up's. */
export const PLACEHOLDER = { new: 'Ask anything', reply: 'Write a message…' };

/** What the panel shows until it is connected: a title, a line, and the one button that moves it on. */
export const STATES = Object.assign(Object.create(null), {
  starting: { spin: true, title: 'Starting MoPilot…', text: 'This takes a few seconds.' },
  connecting: { spin: true, title: 'Connecting…', text: '' },
  offline: { title: "MoPilot isn't running", text: 'Open it to chat from Chrome.', act: 'Open MoPilot', send: 'launch' },
  asking: { title: 'Allow this Chrome in MoPilot', text: 'Click Allow in MoPilot to connect.' },
  unpaired: { title: 'Connect to MoPilot', text: 'Press Connect, then click Allow in MoPilot.', act: 'Connect', send: 'connect' },
  unauthorized: {
    title: 'Connect to MoPilot',
    text: 'Press Connect, then click Allow in MoPilot.',
    act: 'Connect',
    send: 'connect',
  },
  // the two speak different protocol versions: the older side updates (Claude's "Extension Update Required")
  updateExtension: {
    title: 'Extension Update Required',
    text: 'Update the extension to keep using MoPilot.',
    act: 'Update extension',
    send: 'update',
  },
  updateApp: {
    title: 'MoPilot Update Required',
    text: 'Update MoPilot to keep using this extension.',
    act: 'Download MoPilot',
    send: 'download',
  },
  updating: { spin: true, title: 'Updating…', text: 'Chrome is installing the new version.' },
  // Chrome found no native host: MoPilot isn't installed, or was never opened (its first start sets the host up)
  missing: {
    title: 'Get MoPilot',
    text: 'Install MoPilot, or open it once, to chat from Chrome.',
    act: 'Download MoPilot',
    send: 'download',
  },
});

/**
 * The state the background's answer shows; null once connected (the chat shows).
 * @param {{ status?: string, asking?: boolean, starting?: boolean, update?: string, updating?: boolean, missing?: boolean } | undefined} r
 */
export function stateOf(r) {
  if (r?.status === 'connected') return null;
  if (r?.status === 'update-required') {
    if (r.update === 'app') return STATES.updateApp;
    return r.updating ? STATES.updating : STATES.updateExtension;
  }
  if (r?.asking) return STATES.asking;
  if (r?.starting) return STATES.starting;
  if (r?.missing) return STATES.missing;
  return STATES[String(r?.status)] ?? STATES.connecting;
}
