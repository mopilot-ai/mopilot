// What the permissions menu says (D-27), in the app's composer (src/harness/permissionsMenu.ts) and the Chrome side panel's (electron/app/chromePanelOptions.cjs). The four anchors keep Codex's look and shortcuts;
// each row's second line gives the harness's own name for it and the one thing that differs, so
// "Read-only" is not mistaken for the same thing on both: a read-only sandbox that can still ask
// for more on Codex, read tools run and everything else refused on Claude Code.
import { HARNESS_LABEL } from './handoff.mjs';

const MODES = {
  'read-only': 'read-only',
  'full-access': 'full-access',
  'auto-review': 'auto-review',
  plan: 'plan',
  default: 'default',
  acceptEdits: 'default',
  bypassPermissions: 'full-access',
  dontAsk: 'read-only',
  auto: 'auto-review',
};
export function appPermission(mode) {
  return Object.hasOwn(MODES, mode) ? MODES[mode] : null;
}

export const PERMISSION_ORDER = ['read-only', 'default', 'auto-review', 'full-access'];

/** The anchor: the name on the button and the first line of a row. */
export const PERMISSION_LABEL = {
  'read-only': 'Read-only',
  default: 'Ask for approval',
  'auto-review': 'Approve for me',
  'full-access': 'Full access',
};

const NATIVE = {
  codex: {
    'read-only': { name: 'read-only sandbox', diff: 'Can still ask to go beyond it' },
    default: { name: 'workspace-write · on-request', diff: 'Asks before leaving the workspace or using the internet' },
    'auto-review': { name: 'workspace-write · auto review', diff: 'Only actions detected as potentially unsafe come to you' },
    'full-access': { name: 'danger-full-access · never ask', diff: 'No sandbox' },
  },
  claude: {
    'read-only': { name: 'dontAsk', diff: 'Reading tools run; writes and Bash are refused' },
    default: { name: 'default', diff: 'Asks before edits and commands' },
    'auto-review': { name: 'auto', diff: 'A classifier approves safe actions, the rest come to you' },
    'full-access': { name: 'bypassPermissions', diff: 'No prompts and no sandbox' },
  },
};

const LEARN_MORE = {
  codex: 'https://developers.openai.com/codex/security',
  claude: 'https://docs.claude.com/en/docs/claude-code/iam',
};

export function permissionMenu(h) {
  return {
    title: `What ${HARNESS_LABEL[h]} can do`,
    learnMore: LEARN_MORE[h],
    rows: PERMISSION_ORDER.map((id) => ({ id, label: PERMISSION_LABEL[id], detail: `${NATIVE[h][id].name} · ${NATIVE[h][id].diff}` })),
  };
}

/** The Full access banner's body, for the harness the chat runs on. */
export function fullAccessBannerText(h) {
  return `${HARNESS_LABEL[h]} can edit any file, run commands with internet access, and read and interact with websites without your approval. This increases the risk of data loss, exposed information, and unexpected changes.`;
}

export const permissionLearnMore = (h) => LEARN_MORE[h];
