// A machine's ssh address as a person types it (`host`, `user@host`, `host:port`, `ssh://user@host:2222`) and as ssh takes it: one normal form, the target and `-p` ssh is run with, and the name `known_hosts` keeps it under.

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.%+-]*$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9_.%+-]*$/;
const MAX_LENGTH = 255;

/**
 * @param {unknown} raw what was typed or pasted
 * @returns {{ user: string, host: string, port: number, destination: string } | null} `destination`: `user@host` or `host`, with `:port` only when it is not 22; null when it is no ssh address
 */
export function parseSshAddress(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text || text.length > MAX_LENGTH) return null;
  text = text.replace(/^ssh:\/\//i, '').replace(/\/+$/, '');
  const at = text.lastIndexOf('@');
  const user = at < 0 ? '' : text.slice(0, at);
  const rest = at < 0 ? text : text.slice(at + 1);
  // an IPv6 literal: bare (`fe80::1`, port 22, as ssh takes it) or bracketed with a port (`[fe80::1]:2222`)
  const six = /^\[([0-9A-Fa-f:.%]+)\](?::(\d{1,5}))?$/.exec(rest);
  const bare = !six && /^[0-9A-Fa-f:.%]*:[0-9A-Fa-f:.%]*:[0-9A-Fa-f:.%]*$/.test(rest);
  const colon = six || bare ? -1 : rest.indexOf(':');
  const host = six ? six[1] : bare ? rest : colon < 0 ? rest : rest.slice(0, colon);
  const portText = six ? (six[2] ?? '') : colon < 0 ? '' : rest.slice(colon + 1);
  if (!(six || bare ? host.includes(':') : NAME.test(host)) || (at >= 0 && !USER.test(user))) return null;
  let port = 22;
  if (colon >= 0 || portText) {
    if (!/^\d{1,5}$/.test(portText)) return null;
    port = Number(portText);
    if (port < 1 || port > 65535) return null;
  }
  const shown = host.includes(':') && port !== 22 ? `[${host}]` : host;
  const base = user ? `${user}@${shown}` : shown;
  return { user, host, port, destination: port === 22 ? (user ? `${user}@${host}` : host) : `${base}:${port}` };
}

/** An address as the app keeps it: the one normal form when it is an ssh address, else what was given (a local address, or nothing). @param {unknown} raw */
export const normalAddress = (raw) =>
  typeof raw === 'string' && raw.startsWith('local:') ? raw : (parseSshAddress(raw)?.destination ?? String(raw ?? ''));

/** What ssh is run with for a stored destination: its target (`user@host`) and the `-p` that goes before it. @param {string} destination @returns {{ target: string, args: string[] }} */
export function sshTarget(destination) {
  const p = parseSshAddress(destination);
  if (!p) return { target: destination, args: [] };
  return { target: p.user ? `${p.user}@${p.host}` : p.host, args: p.port === 22 ? [] : ['-p', String(p.port)] };
}

/** The name `known_hosts` has the machine under, as `ssh-keygen -R` takes it: the host, or `[host]:port` for a port other than 22. @param {string} destination */
export function knownHostsName(destination) {
  const p = parseSshAddress(destination);
  if (!p) return destination.slice(destination.lastIndexOf('@') + 1);
  return p.port === 22 ? p.host : `[${p.host}]:${p.port}`;
}
