// What the main process names an add by: a typed machine address (host, user@host, host:2222, ssh://user@host:2222/) in its one normal form, which the add's step events, its ssh questions and its cancel all carry.
import { parseSshAddress } from '../../shared/host/sshDestination.mjs';

export const normalDestination = (typed: string): string => parseSshAddress(typed)?.destination ?? typed;
