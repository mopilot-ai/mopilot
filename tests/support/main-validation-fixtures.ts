// Recorded GitHub shapes for paired main validation tests and existing checkout-only CI contract fixtures.
import type { MainCommit, MainStatus } from '../../shared/mainValidation.ts';
import { contexts } from './ciStatuses.ts';

export const HEAD = 'a'.repeat(40);
export const GREEN = 'b'.repeat(40);
export const VALIDATION_NOW = Date.parse('2026-10-20T04:00:00Z');
export const validationAt = (minutes: number) => new Date(VALIDATION_NOW - minutes * 60_000).toISOString();
export const greenStatuses: MainStatus[] = ['main-unit-tests', 'main-e2e'].map((context) => ({ context, state: 'success' }));
export const mainCommit = (sha = HEAD, minutes = 1, statuses: MainStatus[] = []): MainCommit => ({
  sha,
  date: validationAt(minutes),
  message: sha,
  statuses,
});

export function mainGraph(commits: MainCommit[] = [mainCommit(HEAD, 1, greenStatuses)]) {
  return {
    data: {
      repository: {
        ref: {
          target: {
            history: {
              nodes: commits.map((commit, index) => ({
                oid: commit.sha,
                committedDate: commit.date,
                messageHeadline: commit.message,
                parents: { nodes: commits[index + 1] ? [{ oid: commits[index + 1].sha }] : [] },
                status: {
                  contexts: contexts(
                    commit.statuses.map((s) => ({
                      context: s.context,
                      state: s.state.toUpperCase(),
                      ...(s.description === undefined ? {} : { description: s.description }),
                      targetUrl: s.target_url,
                      createdAt: s.updated_at,
                    })),
                  ),
                },
              })),
            },
          },
        },
      },
    },
  };
}

export function validationRun(id = 1, status = 'completed', minutes = 20, conclusion: string | null = 'success') {
  return { id, status, conclusion, created_at: validationAt(minutes), html_url: `https://github.com/o/rel/actions/runs/${id}` };
}
