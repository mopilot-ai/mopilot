// A random UUID for upload streams and chat start ids, from the device's secure random source.
import { getRandomBytes } from 'expo-crypto';
import { requestId } from './requestId';

export const randomId = () => requestId(getRandomBytes);
