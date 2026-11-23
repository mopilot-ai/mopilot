// Test-only image encoder for the web preview: the photo comes back unchanged, as a JPEG with no bytes.
export const SaveFormat = { JPEG: 'jpeg' };
export const manipulateAsync = async (uri: string) => ({ uri, base64: '' });
