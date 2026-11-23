// Live output reveals load the pane opener only for a visual write, keeping notification dispatch independent of UI boot.
import { identityKey } from '../../shared/identityKey.mjs';
import { basename, pathKey } from '../lib/paths';
import { pathSpelling } from '../lib/pathSpelling';
import { noteIgnored } from '../lib/ignored';
import { outputPlaceKnown, resolveOutput } from '../lib/outputResolve';
import { get, set } from './core';
import { chatOf } from './chats';
import { focusedChat } from './split';
import { contextUsageKey } from './contextUsage';
import { sessionOutputs, visualOutput, type OutputWrite } from '../lib/sessionOutputs';

const requests = new Map<string, object>();
const announced = new Map<string, Set<string>>();
let revision = 0;

/** Observe only live writes. History reconstruction is the inventory's job and never reveals historical output. */
export async function revealSessionOutputs(threadId: string, turnId: string, writes?: OutputWrite[]) {
  const s = get();
  const chat = chatOf(threadId);
  const turn = s.runtime[chat]?.turns.at(-1);
  if (focusedChat(s) !== chat || !turn || turn.id !== turnId || turn.undone) return;
  const cwd = s.threads[chat]?.cwd;
  if (!cwd) return;
  // where the chat runs is not known yet: its file is not looked for on this Mac meanwhile
  if (!outputPlaceKnown(chat)) return;
  const token = {};
  requests.set(chat, token);
  if (requests.size > 200) requests.delete(requests.keys().next().value!);
  const paths = (
    writes ? writes.filter((w) => !w.deleted).map((w) => ({ path: pathSpelling(w.path, cwd) })) : sessionOutputs([turn], cwd)
  ).filter((f) => visualOutput(f.path));
  const scope = identityKey(contextUsageKey(s.segments[chat], chat), turnId);
  const seen = announced.get(scope) ?? new Set<string>();
  announced.set(scope, seen);
  if (announced.size > 200) announced.delete(announced.keys().next().value!);
  if (!paths.length) return;
  // Closing an already shown file during the probe cannot make the next update count as its first reveal.
  for (const { path } of paths)
    if (s.paneTabs.some((t) => t.kind === 'file' && t.path && pathKey(t.path) === pathKey(path) && t.ownerChat === chat))
      seen.add(pathKey(path));
  const [{ openPaneTab }, results] = await Promise.all([
    import('./panes'),
    Promise.all(
      paths.map(async ({ path }) => {
        try {
          return await resolveOutput(chat, path, cwd);
        } catch (error) {
          noteIgnored('resolve a generated output', error);
          return null;
        }
      }),
    ),
  ]);
  const now = get();
  if (
    requests.get(chat) !== token ||
    focusedChat(now) !== chat ||
    now.route !== s.route ||
    now.threads[chat]?.cwd !== cwd ||
    now.runtime[chat]?.turns.at(-1)?.id !== turnId ||
    now.runtime[chat]?.turns.at(-1)?.undone ||
    now.runtime[chat]?.turns.at(-1)?.diff !== turn.diff ||
    now.segments[chat] !== s.segments[chat] ||
    now.paneTabs !== s.paneTabs ||
    now.paneActive !== s.paneActive ||
    now.diffPanel !== s.diffPanel
  )
    return;
  for (const found of results) {
    if (!found) continue;
    const key = pathKey(found.path);
    const existing = get().paneTabs.find((t) => t.kind === 'file' && t.ownerChat === chat && t.path && pathKey(t.path) === key);
    const first = !seen.has(key);
    if (first && seen.size >= 500) continue;
    seen.add(key);
    const version = `auto:${++revision}`;
    if (existing) set({ paneTabs: get().paneTabs.map((t) => (t === existing ? { ...t, version } : t)) });
    else if (first) openPaneTab('file', { path: found.path, cwd: found.cwd, ownerChat: chat, title: basename(found.path), version });
  }
  requests.delete(chat);
}
