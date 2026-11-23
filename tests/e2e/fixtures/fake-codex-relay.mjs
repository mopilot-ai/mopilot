// The fake app-server's side of the account relay (#2144): it keeps the relay address a thread was opened with
// (config.openai_base_url, sent with thread/start and thread/resume, never on its command line) and, on a "RELAYPROBE"
// prompt, calls it as the real app-server does for a ChatGPT account, reporting the HTTP status in its reply; on
// "RELAYCHILDPROBE" a process it starts (as a model's command or an MCP server would be) makes that call instead.

/** The relay address in a thread's config, or null. */
export const relayOf = (config) => (typeof config?.openai_base_url === 'string' ? config.openai_base_url : null);

/** " [relay <status>]" for a model request through `base`; "none" when the thread has no relay. */
export async function probeRelay(base, fromChild = false) {
  if (fromChild) return probeFromChild(base);
  if (!base) return ' [relay none]';
  try {
    const r = await fetch(`${base}/responses`, {
      method: 'POST',
      headers: { 'chatgpt-account-id': 'acct-probe', 'session-id': 'probe', 'content-type': 'application/json' },
      body: '{}',
    });
    return ` [relay ${r.status}]`;
  } catch {
    return ' [relay unreachable]';
  }
}

/** " [relay child <status>]": the same request made by a child process of the app-server. */
async function probeFromChild(base) {
  if (!base) return ' [relay child none]';
  const { execFileSync } = await import('node:child_process');
  const code = `fetch(process.argv[1] + '/responses', { method: 'POST', headers: { 'chatgpt-account-id': 'acct-probe' }, body: '{}' }).then((r) => console.log(r.status), () => console.log('unreachable'))`;
  const out = execFileSync(process.execPath, ['-e', code, base], { encoding: 'utf8', timeout: 20_000 }).trim();
  return ` [relay child ${out}]`;
}
