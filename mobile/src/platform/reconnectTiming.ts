// Reconnect pacing in one place: the wait doubles from base to cap with jitter, and attempts never start closer than minGap.
export const reconnectTiming = { baseMs: 1000, capMs: 30000, jitter: 0.2, minGapMs: 1000 };
