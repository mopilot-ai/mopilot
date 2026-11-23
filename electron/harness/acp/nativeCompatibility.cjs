// Native ACP admission requirements shared by discovery and every chat process start.
function nativeCompatibility(q, caps, init) {
  const version = init?.agentInfo?.version;
  if (q.admission?.blockedVersions?.includes(version))
    return `${q.label} ${version} changes shared settings; use a compatible native ACP version`;
  if (q.admission?.requireResume && !caps.loadSession && !caps.resume) return `${q.label} cannot reopen native sessions in this version`;
  return null;
}

module.exports = { nativeCompatibility };
