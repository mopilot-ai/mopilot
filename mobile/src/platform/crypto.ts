// Adapt native sodium and noble primitives to the shared phone cryptography contract.
import sodium from 'react-native-libsodium';
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { createPhonePrimitives } from '../../../shared/remote/phonePrimitives.mjs';

export const phonePrimitives = () => createPhonePrimitives(sodium, { x25519, sha256, hmac });
