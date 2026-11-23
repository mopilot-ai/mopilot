// Content-addressed release workflow identities shared by archive publication and every release dispatcher.
export const RELEASE_WORKFLOW_PATH = '.github/workflows/release.yml';
export const RELEASE_WORKFLOW_PREFIX = 'release-workflow-';

/** A workflow's git blob, never a branch name or an unchecked external value. */
export function workflowRef(blob: unknown): string {
  if (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob)) throw new Error('Invalid release workflow identity');
  return `${RELEASE_WORKFLOW_PREFIX}${blob}`;
}

/** Validate the GitHub Contents record before comparing or addressing a workflow. */
export function workflowBlob(value: unknown): string {
  const sha = value && typeof value === 'object' && !Array.isArray(value) && 'sha' in value ? value.sha : undefined;
  workflowRef(sha);
  return sha as string;
}

/** A tag's name alone proves nothing: its actual workflow must equal the selected source's workflow. */
export function verifiedWorkflowRef(want: string, archived: unknown): string {
  const ref = workflowRef(want);
  if (workflowBlob(archived) !== want) throw new Error(`Archived release workflow ${ref} does not match the source commit`);
  return ref;
}
