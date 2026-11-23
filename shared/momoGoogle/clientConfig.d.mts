import type { ClientConfig } from './types.mjs';
/** Parses the JSON Google offers to download for a Desktop client (`{"installed": {...}}`); throws a short text naming no value. */
export type OAuthEndpoints = { authUri: string; tokenUri: string; revokeUri: string };
/** Google's OAuth endpoints, pinned. */
export declare const GOOGLE_OAUTH: Readonly<OAuthEndpoints>;
export declare function parseClientConfig(text: string, oauth?: OAuthEndpoints): ClientConfig;
/** Loads the client from a file path through the injected reader (the Host's own fs). */
export declare function loadClientConfig(path: string, readFile: (path: string) => Promise<string>): Promise<ClientConfig>;
/** The redirect an iOS OAuth client of this id uses. */
export declare const iosRedirect: (clientId: string) => string;
/** The config of an iOS OAuth client the owner made (an id and no secret). */
export declare function iosClientConfig(clientId: string, oauth?: OAuthEndpoints): ClientConfig;
