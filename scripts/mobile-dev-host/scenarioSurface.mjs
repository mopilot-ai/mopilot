// DEV ONLY: the `surface` scenario: says where a chat's agent works, as the fake Mac's surface.current answers it.

/** @param {{ chats: Map<string, unknown>, setSurface: (chatId: string, surface: object | null) => void }} app */
export function surfaceScenario(app) {
  return {
    usage: 'surface <chat> <https-origin|about:blank|desktop|-> [title or app name]',
    about:
      "says where a chat's agent works, as the Mac's surface.current answers it: a browser page (origin and title), a desktop app, or nothing (-); for the chat header's \"Working in …\" line",
    run(/** @type {string[]} */ args) {
      const [chat, where, ...rest] = args;
      if (!chat || !app.chats.has(chat)) throw new Error(`No chat ${chat ?? ''}.`.trim());
      const words = rest.join(' ');
      if (where === '-') {
        app.setSurface(chat, null);
        return `chat ${chat}: no surface (the Mac answers {} before the first browser or desktop step)`;
      }
      if (where === 'desktop') {
        app.setSurface(chat, { kind: 'desktop', app: { name: words || 'Notes' } });
        return `chat ${chat}: the agent works in the desktop app ${words || 'Notes'}`;
      }
      if (where !== 'about:blank' && !/^https:\/\/[^/\s]+$/.test(where ?? ''))
        throw new Error('Say an https origin, about:blank, desktop or -: run surface <chat> <https-origin|about:blank|desktop|-> [title]');
      app.setSurface(chat, { kind: 'iab', origin: where, ...(words && { title: words }) });
      return `chat ${chat}: the agent works in the browser at ${where}${words ? ` (title "${words}")` : ''}`;
    },
  };
}
