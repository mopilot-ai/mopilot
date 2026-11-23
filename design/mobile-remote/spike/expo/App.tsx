// Dev-client screen: opens the shared vectors with react-native-libsodium, so one launch shows whether the native module,
// HKDF and the XChaCha20-Poly1305 frame format agree with the Node side.
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { x25519 } from '@noble/curves/ed25519';
import sodium, {
  _unstable_crypto_kdf_hkdf_sha256_expand as hkdfExpand,
  _unstable_crypto_kdf_hkdf_sha256_extract as hkdfExtract,
} from 'react-native-libsodium';
import vectors from './vectors.json';

const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const text = new TextEncoder();
const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: string) => hkdfExpand(hkdfExtract(ikm, salt), info, 32);

function headerAad(pair: string, dir: string, ctr: number) {
  const out = new Uint8Array([...text.encode(pair), 0, ...text.encode(dir), 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  new DataView(out.buffer).setBigUint64(out.length - 8, BigInt(ctr));
  return out;
}

// The phone receives m2p: derive the direction key, step the ratchet to the frame's counter, open the box.
function openFrame(frame: (typeof vectors.frames)[number]['frame']) {
  const shared = x25519.getSharedSecret(fromHex(vectors.phoneSk), fromHex(vectors.macPk));
  const salt = text.encode(`mopilot-remote/v1|${vectors.macId}|${vectors.phoneId}`);
  let ck = hkdf(shared, salt, `dir:${frame.dir}`);
  const zeros = new Uint8Array(32);
  let mk = ck;
  for (let i = 0; i < frame.ctr; i++) {
    mk = hkdf(ck, zeros, 'mk');
    ck = hkdf(ck, zeros, 'ck');
  }
  const b64 = (s: string) => sodium.from_base64(s, sodium.base64_variants.ORIGINAL);
  const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, b64(frame.box), headerAad(frame.pair, frame.dir, frame.ctr), b64(frame.nonce), mk);
  return sodium.to_string(pt);
}

export default function App() {
  const [lines, setLines] = useState<string[]>(['running…']);
  useEffect(() => {
    const out: string[] = [];
    try {
      out.push(`phone public key: ${toHex(x25519.getPublicKey(fromHex(vectors.phoneSk))) === vectors.phonePk ? 'PASS' : 'FAIL'}`);
      for (const { text: want, frame } of vectors.frames.filter((f) => f.frame.dir === 'm2p')) {
        out.push(`open m2p ctr ${frame.ctr}: ${openFrame(frame) === want ? 'PASS' : 'FAIL'}`);
      }
    } catch (e) {
      out.push(`ERROR ${(e as Error).message}`);
    }
    setLines(out);
  }, []);
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
      {lines.map((l) => <Text key={l} style={{ fontFamily: 'Menlo', marginBottom: 8 }}>{l}</Text>)}
      <StatusBar style="auto" />
    </View>
  );
}
