export declare class GoogleApiError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string);
}
export type ApiFailure = { status: number; reason: string };
export declare function readError(e: unknown): ApiFailure;
export declare const isRetryable: (f: ApiFailure) => boolean;
export declare const isScopeProblem: (f: ApiFailure) => boolean;
export declare const delay: (ms: number) => Promise<void>;
