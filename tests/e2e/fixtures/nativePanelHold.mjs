// A native test press keeps its minimum duration and waits for the UI's acknowledgement before releasing, even when browser timers run late.
export async function releaseAfterHold(holdMs, settled, release, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  try {
    if (holdMs) await delay(holdMs);
    if (settled) await settled();
  } finally {
    await release();
  }
}
