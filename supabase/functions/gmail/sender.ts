import { Buffer } from 'node:buffer';
import { dkimVerify } from 'mailauth/lib/dkim/verify';
import { getDomain } from 'tldts';
import type { Application } from '../../../shared/types.ts';

export const MAX_RAW_BYTES = 2 * 1024 * 1024;
type Resolver = (name: string, type: string) => Promise<string[][] | string[]>;
export type SenderProof = { verified: false; reason: string } | { verified: true; reason: string; address: string; domain: string; signature: string; messageId: string; date: string; headers: Record<string, string> };
const requiredHeaders = ['from', 'to', 'subject', 'date', 'message-id'];
const mimeHeaders = ['content-type', 'mime-version', 'content-transfer-encoding', 'content-disposition'];
const mailbox = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export function singleMailbox(value: string): string | null {
  const text = value.trim();
  const angle = /^[^<>@,;]*<([^<>]+)>$/.exec(text);
  const address = (angle?.[1] ?? text).trim().toLowerCase();
  return address.length <= 254 && mailbox.test(address) ? address : null;
}
function headersFrom(raw: Uint8Array): Record<string, string[]> | null {
  const prefix = Buffer.from(raw.subarray(0, 65540)).toString('latin1');
  const boundary = prefix.indexOf('\r\n\r\n');
  if (boundary < 0 || boundary > 65536) return null;
  const lines = prefix.slice(0, boundary).replace(/\r\n[ \t]+/g, ' ').split('\r\n');
  if (lines.length > 200) return null;
  const headers: Record<string, string[]> = Object.create(null);
  for (const line of lines) {
    const match = /^([A-Za-z0-9-]{1,78}):[ \t]*(.*)$/.exec(line);
    if (!match || /[\x00-\x08\x0b-\x1f\x7f]/.test(match[2])) return null;
    (headers[match[1].toLowerCase()] ??= []).push(match[2].trim());
  }
  return headers;
}
export function validDkimQuery(name: string): boolean {
  if (name.length > 253 || !/^[a-z0-9_.-]+$/i.test(name)) return false;
  const labels = name.toLowerCase().split('.');
  const key = labels.indexOf('_domainkey');
  return labels.length <= 20 && key >= 1 && key <= 5 && labels.lastIndexOf('_domainkey') === key && labels.length - key >= 3 && labels.every((part, i) => part.length >= 1 && part.length <= 63 && (i === key || (i < key ? /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/ : /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).test(part)));
}
function txtChunks(value: string): string[] {
  if (value.length > 16384) throw new Error('Invalid DNS key.');
  const chunks: string[] = []; let position = 0;
  while (position < value.length) {
    while (/\s/.test(value[position] ?? '') && position < value.length) position++;
    if (position === value.length) break;
    if (value[position++] !== '"') throw new Error('Invalid DNS key.');
    let chunk = ''; let closed = false;
    while (position < value.length) {
      const character = value[position++];
      if (character === '"') { closed = true; break; }
      if (character === '\\') {
        const digits = value.slice(position, position + 3);
        if (/^\d{3}$/.test(digits)) { const code = Number(digits); if (code > 255) throw new Error('Invalid DNS key.'); chunk += String.fromCharCode(code); position += 3; }
        else if (position < value.length) chunk += value[position++]; else throw new Error('Invalid DNS key.');
      } else chunk += character;
    }
    if (!closed) throw new Error('Invalid DNS key.');
    chunks.push(chunk);
  }
  return chunks;
}
export function dnsResolver(signal: AbortSignal): Resolver {
  let count = 0;
  return async (name, type) => {
    if (type !== 'TXT' || !validDkimQuery(name) || ++count > 8) throw new Error('Unsupported DNS lookup.');
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', name); url.searchParams.set('type', 'TXT');
    const response = await fetch(url, { headers: { Accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok || !response.body) throw new Error('DNS lookup failed.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 65536) { await reader.cancel(); throw new Error('DNS response too large.'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { Status?: number; Answer?: Array<{ type: number; data: string }> };
    if (result.Status !== 0 || !Array.isArray(result.Answer) || result.Answer.length > 32) throw new Error('DNS key unavailable.');
    const answers = result.Answer.filter(answer => answer.type === 16 && typeof answer.data === 'string');
    if (answers.length > 8) throw new Error('Too many DNS keys.');
    return answers.map(answer => txtChunks(answer.data));
  };
}
export async function verifySender(raw: Uint8Array, recipient: string, receivedAt: string, signal: AbortSignal, resolver: Resolver = dnsResolver(signal)): Promise<SenderProof> {
  const fail = (reason: string): SenderProof => ({ verified: false, reason });
  if (!raw.length || raw.length > MAX_RAW_BYTES) return fail('Message is too large to verify.');
  const headers = headersFrom(raw);
  if (!headers || requiredHeaders.some(key => headers[key]?.length !== 1) || mimeHeaders.some(key => (headers[key]?.length ?? 0) > 1) || (headers['dkim-signature']?.length ?? 0) > 8) return fail('Message headers could not be verified.');
  const from = singleMailbox(headers.from[0]); const to = singleMailbox(headers.to[0]);
  if (!from || to !== recipient.toLowerCase()) return fail('The signed sender or recipient is ambiguous.');
  const domain = from.split('@')[1];
  const sent = Date.parse(headers.date[0]); const delivered = Date.parse(receivedAt);
  if (!Number.isFinite(sent) || !Number.isFinite(delivered) || sent > delivered + 600000 || sent < delivered - 7 * 86400000) return fail('The message date needs review.');
  if (!/^<[^<>\s]{1,998}>$/.test(headers['message-id'][0])) return fail('Message identity could not be verified.');
  try {
    const result = await dkimVerify(Buffer.from(raw), { resolver, strict: true, minBitLength: 2048, rejectRsaSha1: true });
    signal.throwIfAborted();
    for (const signature of result.results) {
      const signed = new Set((signature.signingHeaders?.keys ?? '').toLowerCase().split(':').map(key => key.trim()));
      if (signature.status.result !== 'pass' || signature.status.testing || signature.signatureTimeValid === false || signature.canonBodyLengthLimited || !['rsa-sha256', 'ed25519-sha256'].includes(signature.algo ?? '') || signature.signingDomain?.toLowerCase() !== domain || !signature.id) continue;
      if ([...requiredHeaders, ...mimeHeaders.filter(key => headers[key])].some(key => !signed.has(key))) continue;
      return { verified: true, reason: 'Sender signature verified.', address: from, domain, signature: signature.id, messageId: headers['message-id'][0], date: new Date(sent).toISOString(), headers: Object.fromEntries(Object.entries(headers).filter(([key]) => [...requiredHeaders, ...mimeHeaders].includes(key)).map(([key, values]) => [key, values[0]])) };
    }
  } catch { signal.throwIfAborted(); }
  return fail('Sender signature could not be verified.');
}
const freeMailDomains = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com']);
const sharedHiringDomains = new Set(['greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'ashbyhq.com', 'workday.com', 'myworkdayjobs.com', 'smartrecruiters.com', 'icims.com', 'workable.com', 'jobvite.com', 'bamboohr.com', 'indeed.com', 'linkedin.com', 'wellfound.com', 'recruitee.com', 'teamtailor.com', 'successfactors.com', 'oraclecloud.com']);
export function associatedSender(proof: SenderProof, application: Application): boolean {
  if (!proof.verified) return false;
  const sender = getDomain(proof.domain, { allowPrivateDomains: true });
  // Shared hiring services sign mail for many employers. Their common sender
  // address does not establish which tenant authored this message.
  if (!sender || sharedHiringDomains.has(sender)) return false;
  if (application.recruiterEmail && singleMailbox(application.recruiterEmail) === proof.address) return true;
  try {
    const url = new URL(application.url);
    if (!['https:', 'http:'].includes(url.protocol)) return false;
    const employer = getDomain(url.hostname, { allowPrivateDomains: true });
    return !!employer && employer === sender && !freeMailDomains.has(employer);
  } catch { return false; }
}
