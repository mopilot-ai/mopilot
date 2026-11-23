// A fake of the GitHub Git Database endpoints scripts/claim-main-red.mjs uses: refs that are created once and move only
// forward, commits by message and parent, and failures a test injects before a call reaches the store.
export type Call = string[];

export const httpError = (status: number, text = 'refused') =>
  Object.assign(new Error(`Command failed: gh api\ngh: ${text} (HTTP ${status})`), { stderr: `gh: ${text} (HTTP ${status})` });

export function claimHub(extra: (args: string[]) => string | undefined = () => undefined) {
  const refs = new Map<string, string>();
  const commits = new Map<string, { message: string; parent: string | null }>();
  const calls: Call[] = [];
  // runs before a call reaches the store; it may throw, or act first (another agent racing)
  let before: (args: string[]) => void = () => {};
  let n = 0;
  const field = (args: string[], name: string) =>
    args.find((a, i) => /^-[fF]$/.test(args[i - 1] ?? '') && a.startsWith(`${name}=`))?.slice(name.length + 1);
  const gh = (args: string[]): string => {
    calls.push(args);
    before(args);
    const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
    const route = args.find((a) => a.startsWith('repos/')) ?? args[1];
    const given = extra(args);
    if (given !== undefined) return given;
    if (route === 'user') return 'agent\n';
    if (method === 'POST' && route.endsWith('/git/trees')) return JSON.stringify({ sha: `tree${++n}` });
    if (method === 'POST' && route.endsWith('/git/commits')) {
      const sha = `c${++n}`.padEnd(40, '0');
      commits.set(sha, { message: field(args, 'message') as string, parent: field(args, 'parents[]') ?? null });
      return JSON.stringify({ sha });
    }
    if (method === 'POST' && route.endsWith('/git/refs')) {
      const name = (field(args, 'ref') as string).replace(/^refs\/heads\//, '');
      if (refs.has(name)) throw httpError(422, 'Reference already exists');
      refs.set(name, field(args, 'sha') as string);
      return '{}';
    }
    const name = /\/git\/refs?\/heads\/(.+)$/.exec(route)?.[1];
    if (method === 'PATCH' && name) {
      const sha = field(args, 'sha') as string;
      if (!refs.has(name)) throw httpError(422, 'Reference does not exist');
      if (commits.get(sha)?.parent !== refs.get(name)) throw httpError(422, 'Update is not a fast forward');
      refs.set(name, sha);
      return '{}';
    }
    if (method === 'DELETE' && name) {
      if (!refs.delete(name)) throw httpError(422, 'Reference does not exist');
      return '';
    }
    const prefix = /\/git\/matching-refs\/heads\/(.+)$/.exec(route)?.[1];
    if (prefix)
      return JSON.stringify(
        [...refs].filter(([r]) => r.startsWith(prefix)).map(([r, sha]) => ({ ref: `refs/heads/${r}`, object: { sha } })),
      );
    if (route.includes('/git/ref/heads/')) {
      if (!refs.has(name as string)) throw httpError(404, 'Not Found');
      return JSON.stringify({ object: { sha: refs.get(name as string) } });
    }
    const commit = /\/git\/commits\/(\w+)$/.exec(route)?.[1];
    if (commit && commits.has(commit)) return JSON.stringify({ message: commits.get(commit)?.message });
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  return {
    gh,
    refs,
    commits,
    calls,
    setBefore: (fn: (args: string[]) => void) => {
      before = fn;
    },
  };
}
