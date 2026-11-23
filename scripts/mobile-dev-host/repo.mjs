// The git repository the dev host's chats work in: a committed baseline plus uncommitted edits, so a phone has a real diff, a new file and a hidden file to review.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FILES = {
  base: {
    'src/price.ts':
      'export const TAX = 0.08;\n\nexport function total(price: number, qty: number) {\n  return price * qty * (1 + TAX);\n}\n',
    'tests/price.test.ts': "import { total } from '../src/price';\n\nconsole.assert(total(10, 2) > 20, 'tax is added');\n",
    'README.md': '# Shop\n\nA tiny price calculator used by the checkout page.\n',
    '.env': 'API_KEY=dev-only\n',
  },
  edits: {
    'src/price.ts':
      'export const TAX = 0.08;\n\nexport function total(price: number, qty: number, discount = 0) {\n  return Math.round(price * qty * (1 - discount) * (1 + TAX) * 100) / 100;\n}\n',
    'notes/todo.md': '- [ ] rounding for JPY\n- [ ] coupon stacking\n',
    '.env': 'API_KEY=changed\n',
  },
};

/** Runs git without a shell. */
const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) =>
  execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@mopilot.local', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: 'pipe',
    maxBuffer: 8 * 1024 * 1024,
  });

const put = (/** @type {string} */ root, /** @type {Record<string, string>} */ files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
};

/** The repository under `dir/repo`, made once (a restart keeps whatever the phone's chats changed since). @returns {string} its path */
export function ensureRepo(/** @type {string} */ dir) {
  const root = path.join(dir, 'repo');
  if (existsSync(path.join(root, '.git'))) return root;
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  put(root, FILES.base);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'Initial price calculator']);
  put(root, FILES.edits);
  return root;
}
