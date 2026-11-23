// Credits as dollars; pure, so the account view can use it without the MoPilot store.
export const formatCredits = (micros: number | null) =>
  micros == null ? '—' : `$${(micros / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
