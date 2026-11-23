// Project an owned more-tools execution as its action without changing the native call or its outcome.
import { isJsonRecord } from './jsonRecord.mjs';

/** An owned server identity, shared by invocation projection and screenshot provenance. */
export const isInvocationServer = (server) => typeof server === 'string' && /^sage(?:_[0-9a-f]{12})?$/i.test(server);

/** @template T @param {T} item @returns {T} A presentation copy; discovery, foreign tools and invalid inputs stay intact. */
export function toolInvocation(item) {
  const it = /** @type {any} */ (item);
  if (!isJsonRecord(it) || typeof it.tool !== 'string') return item;
  const named = /^mcp__(.+?)__(.+)$/.exec(it.tool) ?? /^(sage_[0-9a-f]{12})_(.+)$/i.exec(it.tool);
  const parts = it.tool.split(/[./:]/);
  const tool = named ? named[2] : parts.pop();
  const owners = [it.server, it.namespace, named ? named[1] : parts.join('.')].filter((owner) => owner != null && owner !== '');
  if (owners.some((owner) => !isInvocationServer(owner))) return item;
  if (new Set(owners).size > 1) return item;
  const server = owners[0] ?? '';
  const more = /^(browser|desktop|app)_more_tools$/.exec(tool);
  const args = it.arguments;
  if (!more || !isJsonRecord(args) || typeof args.call !== 'string' || !/^[a-z][a-z0-9_]*$/.test(args.call)) return item;
  const target = args.call;
  if (/_more_tools$/.test(target)) return item;
  const surface = /^(browser|chrome|desktop)_/.exec(target)?.[1] ?? 'app';
  if ((surface === 'chrome' ? 'browser' : surface) !== more[1]) return item;
  const input = args.arguments ?? {};
  if (!isJsonRecord(input)) return item;
  return { ...it, server, tool: target, arguments: input };
}
