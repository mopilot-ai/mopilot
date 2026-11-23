// Durable local audio playback shared by unsent attachments and replayed message history.
import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';

export function AudioMessage({ path }: { path: string }) {
  const [result, setResult] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let current = true;
    setResult({});
    void native.speech.read(path).then(
      (url) => {
        if (current) setResult({ url });
      },
      (e) => {
        if (current) setResult({ error: `Audio message unavailable: ${errorText(e)}` });
      },
    );
    return () => {
      current = false;
    };
  }, [path]);
  if (result.error) return <span role="status">{result.error}</span>;
  return result.url ? (
    <audio className="audio-message" controls src={result.url} aria-label="Audio message" preload="metadata" />
  ) : (
    <span role="status">Loading audio…</span>
  );
}
