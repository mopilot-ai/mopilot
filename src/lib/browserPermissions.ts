// Saving a browser site permission through main and reporting a failed save.

import type { SiteBrowser, SiteGrant } from './native';

/** Publish a site edit only after main saved it; surface persistence failures to the user. `table`: whose site table (the in-app browser's unless named). */
export async function saveSitePermission(
  browser: { setSite(origin: string, level: SiteGrant['level'] | null, table?: SiteBrowser): Promise<SiteGrant[]> },
  origin: string,
  level: SiteGrant['level'] | null,
  saved: (sites: SiteGrant[]) => void,
  failed: (message: string) => void,
  table: SiteBrowser = 'iab',
): Promise<boolean> {
  try {
    saved(await browser.setSite(origin, level, table));
    return true;
  } catch {
    failed("Couldn't save the site permission. Please try again.");
    return false;
  }
}
