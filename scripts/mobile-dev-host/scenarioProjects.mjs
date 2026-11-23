// DEV ONLY: the `projects` scenario: chats of several projects for the Chats home by project, with the logins the Mac names and which one is the computer's default.
import { DEV_REPO } from './fakeData.mjs';

/** @param {{ add: (chat: any) => any, row: (chat: any, role: string, text: string) => void, counter: () => number }} app @param {() => number} now */
export function projectsScenario(app, now) {
  return {
    usage: 'projects',
    about:
      'chats of several projects for the Chats home by project: two projects of one name (told apart by id), idle chats, a chat of no project, and the logins the Mac names (one the computer’s default, one not)',
    run() {
      const at = now();
      const make = (/** @type {string} */ title, /** @type {number} */ ago, /** @type {Record<string, unknown>} */ more) => {
        const chat = app.add({ id: `dev-bench-${app.counter()}`, title: `[bench] ${title}`, harness: 'claude', at: at - ago, ...more });
        app.row(chat, 'user', title);
        return chat;
      };
      make('web: running', 1000, { project: 'web-app', projectId: 'web-app', projectPath: '/Users/dev/code/web-app' });
      make('web: idle', 90 * 60_000, { project: 'web-app', projectId: 'web-app', account: 'me@mopilot.example', accountDefault: true });
      // the seeded dev-repo has only a chat that needs input (which sits under Needs input), so give it one that is going: the two projects of one name show together
      make('repo one: running', 3000, { project: 'dev-repo', projectId: 'dev-repo', projectPath: DEV_REPO });
      make('repo two: running', 2000, {
        project: 'dev-repo',
        projectId: 'dev-repo-2',
        projectPath: '/Users/dev/work/dev-repo',
        account: 'work@mopilot.example',
      });
      make('repo two: idle', 120 * 60_000, { project: 'dev-repo', projectId: 'dev-repo-2', projectPath: '/Users/dev/work/dev-repo' });
      make('loose: newest', 10, {});
      return `six chats: two in web-app, one in the seeded dev-repo and two in a second dev-repo (id dev-repo-2), told apart by their folders ("dev-repo · code" and "dev-repo · work"), and a chat of no project that is the newest; the Chats home by project lists the project of the newest chat first and "No project" last`;
    },
  };
}
