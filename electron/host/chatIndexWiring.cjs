// The chat index (chatIndex.cjs) over the registry's machines: a machine is followed while the registry calls it online, through the same authenticated connection every other Host request uses, and only where something listens (`onChange` is the consumer): a machines service made without one (a test, a tool) dials nothing for the chat list.
const { createChatIndex } = require('./chatIndex.cjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * @param {object} o
 * @param {{ list: () => { id: string, status: string, hostKey?: string }[] }} o.registry
 * @param {(record: any, onEvent: (event: Record<string, any>) => void) => Promise<{ call: (method: string, params?: object) => Promise<any>, close: () => void }>} o.openPaired
 * @param {() => boolean} [o.allowed] whether Host access is open
 * @param {(id: string) => boolean} [o.isOff] a machine this Mac is told not to connect to
 * @param {Parameters<typeof createChatIndex>[0]['notify']} [o.notify]
 * @param {() => void} [o.onChange] who hears of changes; without it no machine is followed
 */
function createMachineChatIndex({ registry, openPaired, allowed = () => true, isOff = () => false, notify, onChange }) {
  const index = createChatIndex({
    open: openPaired,
    // without Host access, or without anyone to tell, nothing is followed and nothing is kept
    machines: () =>
      (onChange && allowed() ? registry.list() : []).map((r) => ({
        id: r.id,
        online: r.status === 'online',
        off: isOff(r.id),
        pin: r.hostKey ?? '',
        record: r,
      })),
    notify,
    onChange,
    report: (e) => noteIgnored('follow a machine’s chat list', e),
  });
  /** The registry's change callback, told to the index first: who is followed follows from what the registry says now. @template {(...a: any[]) => void} F @param {F} onRegistry @returns {F} */
  const wrap = (onRegistry) => /** @type {F} */ ((...a) => (index.sync(), onRegistry(...a)));
  return { ...index, wrap };
}

module.exports = { createMachineChatIndex };
