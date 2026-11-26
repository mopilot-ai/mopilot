// Whether this build keeps the sealed page cache of older chat rows (#5379): off unless the build says so, and when off nothing is read, written or drawn for it.
export const pageCacheOn = (): boolean => process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE === '1';
