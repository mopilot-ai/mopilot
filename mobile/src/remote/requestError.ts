// Preserves a remote reply's stable error code beside its user-facing message at the phone's request boundary.
export function requestError(error?: { code?: string; message?: string }) {
  return Object.assign(new Error(error?.message || 'Request failed'), error?.code ? { code: error.code } : {});
}
