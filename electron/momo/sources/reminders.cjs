// MoMo's Reminders source (#2139 P2): open reminders (title, due, list) read through the helper's EventKit commands, and on request the ones completed since the day Reminders was connected (its backfill floor), never earlier; each read is decided and audited by the hub. Connecting asks macOS for access first.
const { connectWithGrant, idsByTitle, limitOf } = require('./eventKit.cjs');

/**
 * @param {{ hub: InstanceType<typeof import('./hub.cjs').SourcesHub>, eventKit: ReturnType<typeof import('./eventKit.cjs').createEventKit> }} o
 */
function remindersSource({ hub, eventKit }) {
  return {
    id: 'reminders',
    /** Asks macOS for access, then connects: `{ connected, grant }`. */
    connect: () => connectWithGrant(hub, eventKit, 'reminders'),
    /** The lists' titles, for Settings (the user's own view, not a read by MoMo). */
    detail: async () => (await eventKit.lists()).map((c) => c.title),
    /**
     * Open reminders in the named lists (all when none), plus completed ones since the connect day with `includeCompleted`.
     * @param {{ lists?: string[], includeCompleted?: boolean, limit?: number }} args
     * @param {string} chatId
     */
    async items(args, chatId) {
      const floor = hub.floor('reminders');
      const completed = args.includeCompleted === true;
      const summary = `${completed ? 'open and completed' : 'open'} reminders${args.lists?.length ? ` in ${args.lists.length} lists` : ''}`;
      // what the read names, for the audit log's digest (#2284)
      const named = { lists: args.lists, includeCompleted: args.includeCompleted, limit: args.limit };
      return hub.read({ source: 'reminders', action: 'reminders.items', chatId, summary, args: named }, async () => {
        const ids = args.lists?.length ? idsByTitle(await eventKit.lists(), args.lists, 'list') : undefined;
        const r = await eventKit.reminders({
          ...(ids && { ids }),
          ...(completed && { completedSince: floor }),
          limit: limitOf(args.limit),
        });
        return { count: r.items.length, reminders: r.items, truncated: r.truncated === true, floor, completed };
      });
    },
  };
}

module.exports = { remindersSource };
