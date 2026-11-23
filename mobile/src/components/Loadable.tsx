// Runs one owner-scoped read and shows its loading, error-with-retry and result states, so review views repeat none of it.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Text } from 'react-native';
import { explain } from '../remote/client';
import { Button, ErrorLine, useStyles } from './ui';

type Props<T> = { load: () => Promise<T>; what: string; children: (value: T) => ReactNode };

/** One attempt; the wrapper remounts it with a new key to retry, so the read runs exactly once per mount. */
function Attempt<T>({ load, what, children, retry }: Props<T> & { retry: () => void }) {
  const styles = useStyles();
  const [value, setValue] = useState<{ ok: T } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useRef(load);
  useEffect(() => {
    let active = true;
    read.current().then(
      (ok) => active && setValue({ ok }),
      (e) => active && setError(explain(e)),
    );
    return () => {
      active = false;
    };
  }, []);
  if (value) return <>{children(value.ok)}</>;
  if (error)
    return (
      <>
        <ErrorLine text={error} />
        <Button secondary title="Retry" onPress={retry} />
      </>
    );
  return <Text style={styles.muted}>Loading {what}…</Text>;
}

export function Loadable<T>(props: Props<T>) {
  const [attempt, setAttempt] = useState(0);
  return <Attempt key={attempt} {...props} retry={() => setAttempt(attempt + 1)} />;
}
