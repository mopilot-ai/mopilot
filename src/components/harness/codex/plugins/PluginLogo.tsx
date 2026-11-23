// Plugin logo selection and image-failure fallback.
import { useState } from 'react';
import { Blocks } from '../../../ui/icons';
import { assetUrl } from '../../../../lib/paths';
import { useResolvedDark } from '../../../markdown/Markdown';
import type { PluginInterface } from '../../../../protocol/v2/PluginInterface';
import type { Plugin } from './catalog';

const logoSrc = (p: Pick<Plugin, 'interface'>, dark: boolean) => {
  const i: Partial<PluginInterface> = p.interface ?? {};
  const local = (dark && i.logoDark) || i.logo || i.composerIcon;
  if (dark && i.logoUrlDark) return i.logoUrlDark as string;
  if (i.logoUrl) return i.logoUrl as string;
  // a local logo is an absolute path, C:\… on Windows, which a pasted URL would take as its host
  if (local) return assetUrl(local);
  return null;
};
export function PluginLogo({ p, size = 32 }: { p: Pick<Plugin, 'interface'>; size?: number }) {
  const src = logoSrc(p, useResolvedDark());
  const [err, setErr] = useState(false);
  return (
    <span
      className="plugin-logo"
      style={{ width: size, height: size, background: !src || err ? (p.interface?.brandColor ?? undefined) : undefined }}
    >
      {src && !err ? <img src={src} onError={() => setErr(true)} /> : <Blocks size={size * 0.5} />}
    </span>
  );
}
