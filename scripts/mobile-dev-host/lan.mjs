// The Mac's LAN address for the pairing link: the first private IPv4 of an interface that is up, en0 (Wi-Fi) first.
import os from 'node:os';
import devHost from '../../mobile/config/devHost.js';

/**
 * @param {Record<string, os.NetworkInterfaceInfo[] | undefined>} [interfaces]
 * @returns {string | null} the address, null when no interface has a private IPv4
 */
export function lanAddress(interfaces = os.networkInterfaces()) {
  const names = Object.keys(interfaces).sort((a, b) => Number(b === 'en0') - Number(a === 'en0'));
  for (const name of names)
    for (const info of interfaces[name] ?? [])
      if (info.family === 'IPv4' && !info.internal && devHost.isLocalHost(info.address)) return info.address;
  return null;
}
