// The findings the adversarial triage set exposes in the notice code: item id -> finding. An item listed here runs as a todo test (visible, not red); remove it from the list when the code is fixed.
// All fourteen findings of the first review are fixed in PR #5477 (F1-F11 in the notice code, F12-F14 in the brief claim); this is where a new one goes.
export const FINDINGS: Record<string, string> = {};
export const GAPS: Record<string, keyof typeof FINDINGS> = {};
