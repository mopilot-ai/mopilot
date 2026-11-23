// The Host's handler for `chat.login`: pins a chat to one login of its agent, or lets it go (./chatCredentials.mjs); run once per key at the chat's epoch.

/** @param {{ ownRuns?: { chatCredentials?: { setLogin: (p: { chatId: string, login: string | null }) => object } } | null }} deps */
export default ({ ownRuns }) => ({
  effects: {
    'chat.login': (/** @type {{ chatId: string, login: string | null }} */ p) => {
      const credentials = ownRuns?.chatCredentials;
      if (!credentials) throw Object.assign(new Error('This host cannot pin a chat to a login.'), { code: 'unsupported' });
      return credentials.setLogin(p);
    },
  },
});
