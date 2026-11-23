// Adopts main-owned ACP catalogs before publishing admission state, and owns foreground discovery and explicit rechecks.
import { useEffect } from 'react';
import { native, type BasicHarnessStatus } from '../../lib/native';
import { registerInstalledRegistryHarnesses } from '../../harness/registry';
import { set as setState, toast } from '../../store/core';
import { errorText, noteIgnored } from '../../lib/ignored';

let generation = 0;

export function adoptBasicHarnesses(basicHarnesses: BasicHarnessStatus[]) {
  registerInstalledRegistryHarnesses(basicHarnesses);
  setState({ basicHarnesses, basicListed: true });
}

export async function detectBasicHarnesses() {
  const owner = ++generation;
  try {
    const list = await native.acp.harnesses();
    if (owner === generation) adoptBasicHarnesses(list);
  } catch (error) {
    noteIgnored('list the basic harnesses', error);
  }
  if (owner === generation) setState({ basicListed: true });
}

export function useFreshBasics() {
  useEffect(() => void detectBasicHarnesses(), []);
}

export async function recheckBasic(id?: string) {
  const owner = ++generation;
  setState((state) => ({
    basicHarnesses: state.basicHarnesses.map((harness) =>
      (!id || harness.id === id) && harness.state !== 'missing' ? { ...harness, state: 'checking' as const } : harness,
    ),
  }));
  try {
    const list = await native.acp.recheck(id);
    if (owner !== generation) return;
    adoptBasicHarnesses(list);
    const missing = id ? list.find((harness) => harness.id === id && harness.state === 'missing') : undefined;
    if (missing) toast(`${missing.label} still isn't found. Install it, or set its path`);
  } catch (error) {
    if (owner === generation) toast(errorText(error), 'error');
  }
}
