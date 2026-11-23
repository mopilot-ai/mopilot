// shared/vmName.d.mts: types for vmName.mjs (which strings may name a Tart VM or an image).

export declare function isVmName(name: unknown): name is string;
export declare function isImageRef(ref: unknown): ref is string;
export declare function assertVmName(name: unknown): string;
export declare function assertImageRef(ref: unknown): string;
