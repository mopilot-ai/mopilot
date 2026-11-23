import type { GoogleClient, MailMessage } from '../momoNotice/types.d.ts';
import { type GoogleAccount } from './account.mjs';
export declare const MAIL_BACK_MS: number;
export declare const CALENDAR_AHEAD_MS: number;
/** Longest body text handed on, in characters; the rest is cut (the pipeline reads the start of a mail). */
export declare const BODY_CAP = 20000;
/** Where Gmail and Calendar live; a test points both at a fake server. */
export type Endpoints = {
  gmail: string;
  calendar: string;
};
export declare const GOOGLE_ENDPOINTS: Endpoints;
export type ClientOptions = {
  account: GoogleAccount;
  now(): number;
  endpoints: Endpoints;
  /** The home's IANA time zone: "the connect day" is its day, not UTC's. */
  timeZone: string;
  /** Waits between retries (a test passes its own). */
  sleep?: (ms: number) => Promise<void>;
};
export type GoogleMailClient = GoogleClient & {
  /** The newest visible message of a thread with headers and a capped plain-text body; null when the thread is gone or has no visible message. */
  getMail(threadId: string): Promise<MailMessage | null>;
};
export declare function createGoogleClient(options: ClientOptions): GoogleMailClient;
/** The first instant of the day `ms` falls in, in `timeZone`. */
export declare function startOfDayIn(ms: number, timeZone: string): number;
/** The text of an HTML part in one linear pass; tags, comments, style and script content dropped. */
export declare function htmlToText(html: string): string;
