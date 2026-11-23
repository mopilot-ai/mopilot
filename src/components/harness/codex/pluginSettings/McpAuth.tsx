// Codex MCP OAuth: await completion notifications, retain browser recovery, and retire late work when the row closes.
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { codexRequest, onCodexNotification } from '../../../../harness/adapters/codex';
import { native } from '../../../../lib/native';
import { errorText } from '../../../../lib/ignored';
import { useWindowListener } from '../../../../lib/effects';
import { Menu, MenuItem, useAnchor } from '../../../ui/Popover';
import { ChevronDown } from '../../../ui/icons';
import type { McpServerOauthLoginResponse } from '../../../../protocol/v2/McpServerOauthLoginResponse';
import type { ListMcpServerStatusResponse } from '../../../../protocol/v2/ListMcpServerStatusResponse';

const REGISTRATION = [
  { value: 'auto', label: 'Automatic', short: 'Auto' },
  { value: 'cimd', label: 'Client ID metadata document (CIMD)', short: 'CIMD' },
  { value: 'dcr', label: 'Dynamic client registration (DCR)', short: 'DCR' },
];
type Attempt = { timer?: ReturnType<typeof setTimeout>; read: number };

export function McpAuth({ name, signedIn, onDone }: { name: string; signedIn: boolean; onDone: () => void }) {
  const [mode, setMode] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const done = useEffectEvent(onDone);
  const a = useAnchor();
  const retire = useCallback(() => {
    if (attempt.current) clearTimeout(attempt.current.timer);
    attempt.current = null;
  }, []);
  const verify = useEffectEvent(async (own: Attempt) => {
    const read = ++own.read;
    try {
      const result = await codexRequest<ListMcpServerStatusResponse>('mcpServerStatus/list', {});
      if (attempt.current !== own || own.read !== read) return;
      if (!result || !Array.isArray(result.data)) throw new Error('The server returned an invalid connection status.');
      if (!signedIn && result.data.some((s) => s?.name === name && s.authStatus === 'oAuth')) {
        retire();
        setBusy(false);
        setUrl(null);
        setError(null);
      }
      done();
    } catch (e) {
      if (attempt.current === own && own.read === read) setError(`Couldn't check the connection: ${errorText(e)}`);
    }
  });
  useEffect(() => {
    const off = onCodexNotification((method, params) => {
      if (method !== 'mcpServer/oauthLogin/completed' || !attempt.current) return;
      const p = params as { name?: unknown; threadId?: unknown; success?: unknown } | null;
      if (!p || p.name !== name || p.threadId != null || typeof p.success !== 'boolean') return;
      // Notifications have no attempt id. A late failure is only a hint to read current credentials.
      void verify(attempt.current);
    });
    return () => {
      retire();
      off();
    };
  }, [name, retire]);
  useWindowListener('focus', () => {
    if (attempt.current) done();
  });

  const open = async (page: string, own: Attempt) => {
    try {
      await native.shell.openExternal(page);
    } catch (e) {
      if (attempt.current === own) setError(`Couldn't open the sign-in page: ${errorText(e)}`);
    }
  };
  const start = async () => {
    if (attempt.current) return;
    const own: Attempt = { read: 0 };
    attempt.current = own;
    setBusy(true);
    setUrl(null);
    setError(null);
    own.timer = setTimeout(() => {
      if (attempt.current !== own) return;
      retire();
      setBusy(false);
      setUrl(null);
      setError('Sign-in has not completed. Check the connection or try again.');
    }, 120_000);
    try {
      const r = await codexRequest<McpServerOauthLoginResponse>('mcpServer/oauth/login', {
        name,
        clientRegistration: mode === 'auto' ? null : mode,
      });
      if (attempt.current !== own) return;
      if (!r || typeof r.authorizationUrl !== 'string' || !/^https?:\/\//i.test(r.authorizationUrl))
        throw new Error('The server did not provide a valid sign-in page.');
      setUrl(r.authorizationUrl);
      await open(r.authorizationUrl, own);
    } catch (e) {
      if (attempt.current !== own) return;
      retire();
      setBusy(false);
      setError(errorText(e));
    }
  };

  return (
    <span className="ps-mcp-controls">
      <button ref={a.ref} className="ps-btn sm pad12" disabled={busy} onClick={a.toggle} aria-label="OAuth registration options">
        {REGISTRATION.find((r) => r.value === mode)!.short} <ChevronDown size={14} strokeWidth={2} />
      </button>
      <button className="ps-btn sm" disabled={busy} onClick={start}>
        {busy ? 'Waiting for sign-in…' : signedIn ? 'Reauthenticate' : 'Authenticate'}
      </button>
      {busy && signedIn && <span role="status">Finish in your browser, then check the connection.</span>}
      {(busy || error) && (
        <button
          className="ps-btn sm"
          onClick={() => {
            retire();
            setBusy(false);
            setUrl(null);
            done();
          }}
        >
          Check connection
        </button>
      )}
      {url && (
        <button
          className="ps-btn sm"
          onClick={() => {
            if (attempt.current) return open(url, attempt.current);
          }}
        >
          Open sign-in page
        </button>
      )}
      {error && <span role="alert">{error}</span>}
      <Menu anchor={a.anchor} open={a.open} onClose={a.close} placement="bottom-end" width={290}>
        {REGISTRATION.map((r) => (
          <MenuItem key={r.value} onSelect={() => setMode(r.value)} checked={mode === r.value}>
            {r.label}
          </MenuItem>
        ))}
      </Menu>
    </span>
  );
}
