// The fake ACP agent's sessions on disk (fake-acp-agent.mjs, $FAKE_ACP_STATE): a session's folder and history, so session/load and resume find it after a restart.
import fs from 'node:fs';
import path from 'node:path';

/** save(id, session) and saved(id) for the state folder `state` (null: nothing is kept). */
export function savedSession(state) {
  const file = (id) => (state ? path.join(state, `${encodeURIComponent(id)}.json`) : null);
  return {
    save(id, s) {
      const f = file(id);
      if (!f) return;
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ cwd: s.cwd, history: s.history }));
    },
    saved(id) {
      const f = file(id);
      try {
        return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
      } catch {
        return null;
      }
    },
  };
}
