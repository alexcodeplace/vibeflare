type Base64Bytes = Uint8Array & {
  toBase64?: () => string;
};

type Base64BytesConstructor = Uint8ArrayConstructor & {
  fromBase64?: (value: string) => Uint8Array;
};

export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Base64Bytes).toBase64;
  if (typeof native === 'function') return native.call(bytes);

  // Compatibility fallback for older workerd/V8 builds. Chunking avoids the
  // quadratic string growth of appending one character per byte.
  const chunks: string[] = [];
  const size = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + size)));
  }
  return btoa(chunks.join(''));
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

export function base64ToArrayBuffer(value: string): ArrayBuffer {
  const fromBase64 = (Uint8Array as Base64BytesConstructor).fromBase64;
  if (typeof fromBase64 === 'function') {
    const bytes = fromBase64.call(Uint8Array, value);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let offset = 0; offset < binary.length; offset += 0x8000) {
    const end = Math.min(offset + 0x8000, binary.length);
    for (let i = offset; i < end; i++) bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
