// Capture the intended pending pair before waiting; only a locally owned late claim may become the cleanup target.
/** @param {{ getPending: () => Promise<any>, settling: Promise<unknown> | null, localOwner: () => string | null, current: () => boolean }} o */
export async function cleanupTarget(o) {
  const check = () => {
    if (!o.current()) throw new Error('Pair cleanup cancelled');
  };
  let target = await o.getPending();
  check();
  if (o.settling)
    await o.settling.then(
      () => undefined,
      () => undefined,
    );
  check();
  const owner = o.localOwner();
  if (!target && owner) {
    const current = await o.getPending();
    if (current?.owner === owner) target = current;
  }
  check();
  return target;
}

// Remove only the claimed retired pair; terminal join refusals leave an honest computer-side notice.
/** @param {{ claim: any, relayUrl: string, prepare: () => Promise<void>, connect: () => Promise<unknown>, join: (pair: string) => Promise<unknown>, remove: (pair: string) => Promise<unknown>, current: () => boolean }} o */
export async function removePending(o) {
  const check = () => {
    if (!o.current()) throw new Error('Pair cleanup cancelled');
  };
  const notice = 'If pairing still appears on your computer, dismiss it there.';
  if (new URL(o.claim.relay).href !== new URL(o.relayUrl).href) throw new Error('Untrusted pair relay');
  if (o.claim.cleanupFrom !== 'prepared' && o.claim.cleanupFrom !== 'joining') throw new Error('Invalid pair cleanup state');
  if (o.claim.cleanupFrom === 'prepared') return notice;
  await o.prepare();
  await o.connect();
  check();
  try {
    await o.join(o.claim.pairId);
  } catch (error) {
    if (!(error instanceof Error) || !['relay: unknown_pair', 'relay: expired', 'relay: taken'].includes(error.message)) throw error;
    check();
    return notice;
  }
  check();
  try {
    await o.remove(o.claim.pairId);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'relay: unknown_pair') throw error;
    return notice;
  }
  return null;
}
