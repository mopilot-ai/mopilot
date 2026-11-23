export type Sealer = {
  generateKeyPair(): { publicKey: string; privateKey: string };
  seal(publicKey: string, plaintext: string, context: string): string;
  open(privateKey: string, sealed: string, context: string): string;
};
export declare function createSealer(p: import('../remote/crypto.mjs').Primitives): Sealer;
