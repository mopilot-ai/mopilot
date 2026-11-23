// Read a JSON object record without assuming field whitespace or escape spelling.
export const isJsonRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Any JSON value, as a typed result: text that is not JSON is a normal answer here, not an exception. */
export function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }
}

export function parseJsonRecord(text) {
  const parsed = parseJson(text);
  if (!parsed.ok) return { ok: false, error: 'Invalid JSON record' };
  if (!isJsonRecord(parsed.value)) return { ok: false, error: 'Expected a JSON object' };
  return { ok: true, record: parsed.value };
}

/** Read a string field from a bounded prefix even when a later large value is incomplete. */
export function jsonStringField(text, key) {
  for (const match of text.matchAll(/("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    const parsed = parseJsonRecord(`{${match[1]}:${match[2]}}`);
    if (parsed.ok && Object.hasOwn(parsed.record, key)) return parsed.record[key];
  }
  return null;
}
