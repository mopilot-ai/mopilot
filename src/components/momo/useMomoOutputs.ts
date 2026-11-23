// The files MoMo saved, for the Outputs section of its right panel (#2139): read while the panel is mounted and again whenever main says a file was saved or deleted.
import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import type { MomoOutput } from '../../lib/native/momoOutputs';
import { errorText } from '../../lib/ignored';

export type MomoOutputsState = { status: 'loading' } | { status: 'ready'; files: MomoOutput[] } | { status: 'error'; message: string };

export function useMomoOutputs(): MomoOutputsState {
  const [state, setState] = useState<MomoOutputsState>({ status: 'loading' });
  useEffect(() => {
    let latest = 0;
    const read = () => {
      const seq = ++latest;
      native.momoOutputs
        .list()
        .then((r) => (r.ok ? ({ status: 'ready', files: r.files } as const) : ({ status: 'error', message: r.error } as const)))
        .catch((e: unknown) => ({ status: 'error', message: errorText(e) }) as const)
        .then((next) => {
          if (seq === latest) setState(next);
        });
    };
    const off = native.momoOutputs.onChanged(read);
    read();
    return () => {
      latest = -1;
      off();
    };
  }, []);
  return state;
}
