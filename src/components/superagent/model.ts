// Settings › Superagent: the short lines the page shows, derived from what main sends (src/lib/native/superagent.ts), kept apart from the components so each can be read and tested alone.
import type { SuperagentProblem, SuperagentSource, SuperagentStats } from '../../lib/native/superagent';

/** What the watcher is doing, in one line. */
export function sourceText(source: SuperagentSource): string {
  if (source.state === 'watching') {
    const { health } = source;
    if (health?.state === 'error') return `Can't read ${source.repo}: ${health.reason ?? 'GitHub did not answer'}. Trying again.`;
    if (health?.state === 'limited') return `Watching ${source.repo}. GitHub is limiting requests; waiting.`;
    return `Watching ${source.repo}`;
  }
  switch (source.reason) {
    case 'no_repo':
      return 'Pick a repository to start.';
    case 'paused':
      return 'Paused.';
    case 'error':
      return 'The GitHub source could not start. Change the repository to try again.';
    case 'no_source':
      return 'This build has no GitHub source yet.';
    case 'off':
      return 'Off.';
    default:
      return 'Starting…';
  }
}

/** How often "would accept" was right, once something is marked. */
export function precisionText(stats: SuperagentStats): string {
  if (stats.precision === null) return 'Mark entries Right or Wrong to measure it.';
  return `${Math.round(stats.precision * 100)}% right (${stats.right} of ${stats.marked} marked)`;
}

/** The error shown when Superagent has no database to work with: one short line, and where a damaged copy is kept. */
export function problemText(error: SuperagentProblem): string {
  if (error.code === 'damaged') {
    const kept = error.setAside ? ` The damaged copy is kept at ${error.setAside}.` : ' The damaged copy was left in place.';
    return `Superagent can't read its database.${kept}`;
  }
  if (error.code === 'newer') return 'The database is from a newer MoPilot. Update to use Superagent.';
  if (error.code === 'off') return 'Superagent is off.';
  return `${error.message.replace(/\.$/, '')}. Trying again.`;
}

/** The logins a person typed (commas, spaces or new lines between), without empties. */
export const loginsFrom = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean);
