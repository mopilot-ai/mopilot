// The macOS Quick Actions' status (window.native.app.quickActions, electron/bridge/app.cjs).

/** `unavailable`: not a Mac or not an installed app; `stale`: written for another copy of the app, or incomplete. */
export type QuickActionsStatus = { state: 'unavailable' | 'off' | 'on' | 'stale'; installed: number; total: number };
