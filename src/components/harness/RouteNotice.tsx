// The note under a harness's row and on its page when its own config sends it somewhere else (a gateway such as magpie, another endpoint, a cloud), when MoPilot can't read that config, or when a running process still has the old one: where requests go, Show config file and Restart to apply.
import { useState } from 'react';
import { native } from '../../lib/native';
import { abbreviateHome } from '../../lib/paths';
import { errorText } from '../../lib/ignored';
import { toast } from '../../store/core';
import type { HarnessRouteEntry } from '../../lib/native/routes';
import { hostOf, routeName, routeSentence, routeShown, routeTag, staleText, usageRouteNote, useHarnessRoute } from '../../harness/routes';

/** What a route turned off in MoPilot. The relay is decided when MoPilot starts, so it stays off after the route goes. */
const EFFECT_TEXT = {
  poolingOff: (r: HarnessRouteEntry) =>
    r.kind === 'external'
      ? `MoPilot's account pooling is off while requests go through ${routeName(r) ?? 'another endpoint'}.`
      : "MoPilot's account pooling stays off until you quit and reopen MoPilot.",
  routedOff: (r: HarnessRouteEntry) =>
    `${r.file ? abbreviateHome(r.file) : 'Its own config'} sends requests to ${routeName(r) ?? 'another endpoint'}, so your own provider is off.`,
};

/**
 * `harness`: 'codex', 'claude' or 'acp:<id>'; `label`: its name as the user sees it. Says nothing while the
 * harness goes to its own vendor on the config its processes started with.
 */
export function RouteNotice({ harness, label, variant = 'row' }: { harness: string; label: string; variant?: 'row' | 'card' }) {
  const r = useHarnessRoute(harness);
  const [restarting, setRestarting] = useState(false);
  if (!routeShown(r)) return null;
  const tag = routeTag(r);
  const details = r.kind === 'external' ? [r.model, r.label === hostOf(r.endpoint) ? null : hostOf(r.endpoint)].filter(Boolean) : [];
  const stale = staleText(r, label);
  const restart = async () => {
    setRestarting(true);
    try {
      const { restarted, busy } = await native.routes.restartIdle(harness);
      if (restarted) toast(`${label} restarted on its current config`, 'success');
      else if (busy) toast(`${label} is still working; restart once it is done`, 'info');
    } catch (e) {
      toast(`Couldn't restart ${label}: ${errorText(e)}`, 'error');
    } finally {
      setRestarting(false);
    }
  };
  const reveal = () => void native.routes.reveal(harness).catch((e) => toast(`Couldn't show the config file: ${errorText(e)}`, 'error'));
  return (
    <div className={`route-note route-note-${variant} ${r.kind}`} data-route={harness}>
      <div className="route-note-head">
        {tag && (
          <span className="route-tag">
            <span aria-hidden="true">⇄ </span>
            {tag}
          </span>
        )}
        {details.length > 0 && <span className="route-details">{details.join(' · ')}</span>}
      </div>
      {r.kind !== 'direct' && <p className="route-text">{routeSentence(r, label)}</p>}
      {r.effects.map((e) => (
        <p key={e} className="route-text">
          {EFFECT_TEXT[e](r)}
        </p>
      ))}
      {stale && <p className="route-text route-stale">{stale}</p>}
      <div className="route-actions">
        {r.file && (
          <button type="button" className="link-btn" aria-label={`Show ${abbreviateHome(r.file)} in Finder`} onClick={reveal}>
            Show config file
          </button>
        )}
        {r.stale.idle > 0 && (
          <button type="button" className="btn-pill" disabled={restarting} onClick={() => void restart()}>
            {restarting ? 'Restarting…' : 'Restart to apply'}
          </button>
        )}
      </div>
    </div>
  );
}

/** Beside a harness's account usage: these readings are its sign-in's, while its requests go somewhere else. */
export function RouteUsageNote({ harness, label }: { harness: string; label: string }) {
  const r = useHarnessRoute(harness);
  const text = r ? usageRouteNote(r, label) : null;
  if (!r || !text) return null;
  return (
    <p className="route-note route-usage" data-route-usage={harness}>
      <span className="route-tag">
        <span aria-hidden="true">⇄ </span>
        {routeTag(r)}
      </span>
      <span className="route-text">{text}</span>
    </p>
  );
}
