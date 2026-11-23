// Owns the main-red issue marker and scoped-success protocol for CI and packaged repair coordination.
export const SCOPED_MARK = '(scoped:';
/** @param {string | null | undefined} [description] */
export const isScoped = (description) => (description ?? '').includes(SCOPED_MARK);
/** @param {string | null | undefined} body @returns {{context: string, sha: string, files: string[] | null, tests?: string[]} | null} */
export function issueMarker(body) {
  try {
    const m = /<!-- main-red (\{.*?\}) -->/.exec(body ?? '');
    const parsed = m ? JSON.parse(m[1]) : null;
    return typeof parsed?.context === 'string' &&
      /^[0-9a-f]{40}$/i.test(parsed.sha) &&
      (parsed.files === null || Array.isArray(parsed.files))
      ? parsed
      : null;
  } catch {
    return null;
  }
}
