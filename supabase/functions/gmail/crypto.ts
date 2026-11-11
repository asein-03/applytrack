const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.length > 100_000) throw new Error('Invalid encrypted value.');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
}
export function randomSecret(bytes = 32): string { return base64url(crypto.getRandomValues(new Uint8Array(bytes))); }
export async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
}
export async function secretsEqual(left: string, right: string): Promise<boolean> {
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(left)));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(right)));
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}
export class TokenCipher {
  private readonly key: Promise<CryptoKey>;
  constructor(secret: string) {
    const bytes = unbase64(secret);
    if (bytes.length !== 32) throw new Error('Gmail encryption is not configured.');
    this.key = crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  async seal(value: unknown, context: readonly string[]): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const result = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify(context)) }, await this.key, encoder.encode(JSON.stringify(value)));
    return `v1.${base64url(iv)}.${base64url(new Uint8Array(result))}`;
  }
  async open<T>(value: string, context: readonly string[]): Promise<T> {
    if (value.length > 65_536) throw new Error('Invalid encrypted value.');
    const [version, nonce, ciphertext, extra] = value.split('.');
    if (version !== 'v1' || !nonce || !ciphertext || extra !== undefined) throw new Error('Invalid encrypted value.');
    const iv = unbase64(nonce);
    if (iv.length !== 12) throw new Error('Invalid encrypted value.');
    const result = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify(context)) }, await this.key, unbase64(ciphertext));
    return JSON.parse(decoder.decode(result)) as T;
  }
}
export const tokenContext = (userId: string, id: string, generation: string) => ['gmail-token', userId, id, generation];
export const stateContext = (userId: string, stateHash: string) => ['gmail-oauth', userId, stateHash];
