// Transcript evidence belongs to the latest ACP native-session generation, including replacements that reuse an id.
export function latestAcpSessionRecords(records) {
  return records.slice(records.findLastIndex((record) => record.t === 'session') + 1);
}
