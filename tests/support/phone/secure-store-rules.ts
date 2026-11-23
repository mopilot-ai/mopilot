// The rules expo-secure-store enforces on every call, for the phone tests' stand-ins: a key is only letters, digits, ".", "-" and "_"; a value is a string.
export function checkSecureKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !/^[\w.-]+$/.test(key))
    throw new Error(
      'Invalid key provided to SecureStore. Keys must not be empty and contain only alphanumeric characters, ".", "-", and "_".',
    );
}
export function checkSecureValue(value: unknown): asserts value is string {
  if (typeof value !== 'string')
    throw new Error(
      'Invalid value provided to SecureStore. Values must be strings; consider JSON-encoding your values if they are serializable.',
    );
}
