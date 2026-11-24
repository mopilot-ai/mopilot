// The tabs of Settings › Connections, by direction, and the route that opens one: kept apart from the page so a link anywhere in the app can name a tab without loading the settings page.
export const CONNECTION_TABS = [
  { id: 'this-mac', label: 'Control this Mac' },
  { id: 'other', label: 'Control other devices' },
  { id: 'ssh', label: 'SSH' },
] as const;
export type ConnectionTab = (typeof CONNECTION_TABS)[number]['id'];

/** The route that opens Settings › Connections on one tab. */
export const connectionsRoute = (tab: ConnectionTab) => ({ name: 'settings' as const, section: 'connections', tab });
