import { secretsEqual, sha256 } from './crypto.ts';

const encoder = new TextEncoder();
const targetPath = '/functions/v1/gmail';
export async function signDispatch(secret: string, issuedAt: number, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = `applytrack-gmail-dispatch-v1\nPOST\n${targetPath}\nwork\n${issuedAt}\n${nonce}`;
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  return Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function verifyDispatch(request: Request, secret: string, consume: (nonceHash: string, issuedAt: number) => Promise<boolean>, now = Date.now()): Promise<boolean> {
  if (secret.length < 32 || request.headers.has('X-Apply-Gmail-Worker') || ![targetPath, '/gmail'].includes(new URL(request.url).pathname)
    || request.headers.get('X-Apply-Gmail-Dispatch-Version') !== '1') return false;
  const timestamp = request.headers.get('X-Apply-Gmail-Timestamp') || '';
  const nonce = request.headers.get('X-Apply-Gmail-Nonce') || '';
  const signature = request.headers.get('X-Apply-Gmail-Signature') || '';
  if (!/^\d{10,12}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const issuedAt = Number(timestamp);
  const current = Math.floor(now / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > current + 15 || issuedAt < current - 90) return false;
  if (!await secretsEqual(signature, await signDispatch(secret, issuedAt, nonce))) return false;
  return consume(await sha256(nonce), issuedAt);
}
