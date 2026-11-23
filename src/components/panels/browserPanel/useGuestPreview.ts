// Legacy guests wait for their owned local preview before mounting; retry and cleanup retain navigation ownership.
import { useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';

function local(url: string) {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export function useGuestPreview(url: string, chat: string | null, enabled: boolean, generation: number) {
  const needed = enabled && !!chat && local(url);
  const key = JSON.stringify([url, chat, generation]);
  const owner = useRef<object | null>(null);
  const [result, setResult] = useState<{ key: string; url: string | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!needed) return;
    const request = {};
    owner.current = request;
    native.browser.preparePreview(chat, url).then(
      (resolved) => owner.current === request && setResult({ key, url: resolved, error: null }),
      () =>
        owner.current === request &&
        setResult({ key, url: null, error: 'The preview server could not restart. Check its preview logs, then retry this page.' }),
    );
    return () => {
      if (owner.current === request) owner.current = null;
    };
  }, [needed, key, chat, url]);
  const current = result?.key === key ? result : null;
  const cancel = () => {
    owner.current = null;
    setResult({ key, url: null, error: 'The preview load was stopped. Retry to open it.' });
  };
  return needed
    ? { url: current?.url ?? null, error: current?.error ?? null, pending: !current, cancel }
    : { url, error: null, pending: false, cancel };
}
