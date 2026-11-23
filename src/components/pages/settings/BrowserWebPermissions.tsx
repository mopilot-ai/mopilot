// Settings → Browser → Site permissions: sites the built-in browser lets use the camera, microphone, location or notifications for good, each with Remove.
//
// "Always allow for this site" on a page's permission card (electron/capabilities/browser/webPermissions.cjs)
// is kept in browser-web-permissions.json for every harness's chats; removing a site makes its pages ask again.
import { ownTable } from '../../../../shared/ownTable.mjs';
import { useEffect, useState } from 'react';
import { native, type WebPermissionSite } from '../../../lib/native';
import { toast } from '../../../store/core';
import { Group, Row } from '../Settings';

const LABELS: Record<WebPermissionSite['permissions'][number], string> = ownTable({
  camera: 'Camera',
  microphone: 'Microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
});

/** What a site may use, as one line ("Camera, Microphone"). */
export const permissionsText = (site: WebPermissionSite) => site.permissions.map((p) => LABELS[p] ?? p).join(', ');

export function BrowserWebPermissions() {
  const [sites, setSites] = useState<WebPermissionSite[] | null>(null);
  useEffect(() => {
    let live = true;
    native.browser.webPermissions().then(
      (s) => live && setSites(Array.isArray(s) ? s : []),
      () => live && setSites([]),
    );
    return () => {
      live = false;
    };
  }, []);
  const remove = async (origin: string) => {
    try {
      const left = await native.browser.forgetWebPermission(origin);
      setSites(Array.isArray(left) ? left : []);
    } catch {
      toast("Couldn't remove the site permission. Please try again.", 'error');
    }
  };
  return (
    <Group title="Site permissions" desc="Sites you chose “Always allow” for in the built-in browser. Removing one makes it ask again.">
      {sites === null ? null : (
        <Row
          title={sites.length === 0 ? 'No sites' : 'Always allowed'}
          desc={
            sites.length === 0 ? 'Sites you always allow to use your camera, microphone, location or notifications show here.' : undefined
          }
        >
          {sites.length > 0 && (
            <ul className="web-permission-sites">
              {sites.map((site) => (
                <li key={site.origin}>
                  <span>
                    {site.origin} · {permissionsText(site)}
                  </span>
                  <button className="btn-pill soft" aria-label={`Remove ${site.origin}`} onClick={() => remove(site.origin)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Row>
      )}
    </Group>
  );
}
