import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { dkimSign } from 'mailauth/lib/dkim/sign';
import { verifySender, associatedSender, validDkimQuery, dnsResolver, MAX_RAW_BYTES } from '../supabase/functions/gmail/sender.ts';
import { syncConnection } from '../supabase/functions/gmail/sync.ts';
import { GmailHttpError, emptyCursor, type GmailSyncConnection, type WorkspaceState, type GmailSyncContext } from '../supabase/functions/gmail/shared.ts';
import type { Application } from '../shared/types.ts';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const resolver = async () => [[`v=DKIM1; k=rsa; p=${publicKey}`]];
const now = new Date(); now.setMilliseconds(0);
const date = now.toUTCString();
const received = now.toISOString();
const app = (extra: Partial<Application> = {}): Application => ({ id: 'app1', workspace: 'personal', company: 'Northstar', role: 'Data Analyst', stage: 'applied', url: 'https://jobs.northstar.example/data', jobId: '', email: 'candidate@example.com', recruiterEmail: 'hiring@northstar.example', notes: '', location: '', salary: '', jobType: '', workMode: '', description: '', contacts: '', appliedAt: received, createdAt: received, updatedAt: received, tasks: [], evidence: [], timeline: [], documents: [], ...extra } as Application);
async function signed(options: { body?: string; to?: string; domain?: string; from?: string; headers?: string[]; maxBodyLength?: number } = {}) {
  const body = options.body ?? 'Please complete your assessment. Deadline: 2026-11-16.';
  const headers = [ ['From', options.from ?? 'Northstar Hiring <hiring@northstar.example>'], ['To', options.to ?? 'candidate@example.com'], ['Subject', 'Northstar Data Analyst application'], ['Date', date], ['Message-ID', '<unique-assessment@northstar.example>'], ['MIME-Version', '1.0'], ['Content-Type', 'text/plain; charset=utf-8'] ];
  const source = `${headers.map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n${body}\r\n`;
  const signature = await dkimSign(source, { headerList: options.headers ?? headers.map(([name]) => name), signatureData: [{ signingDomain: options.domain ?? 'northstar.example', selector: 'test', privateKey, ...(options.maxBodyLength === undefined ? {} : { maxBodyLength: options.maxBodyLength }) }] });
  assert.equal(signature.errors.length, 0);
  const raw = Buffer.from(signature.signatures + source);
  const payload = { mimeType: 'text/plain', headers: headers.map(([name, value]) => ({ name, value })), body: { data: Buffer.from(body).toString('base64url') } };
  return { raw, payload };
}
const connection = (extra: Partial<GmailSyncConnection> = {}): GmailSyncConnection => ({ id: 'inbox1', userId: 'owner1', generation: 'generation1', email: 'candidate@example.com', connectedAt: received, lastSyncAt: null, syncAfter: new Date(now.getTime() - 30 * 86400000).toISOString(), ...emptyCursor(), ...extra });
function backend(applications = [app()]) {
  let state: WorkspaceState = { version: 1, applications, metadata: [], processed: [] }; let revision = 0;
  return { get state() { return state; }, readWorkspace: async () => ({ revision, state: structuredClone(state) }), commitWorkspace: async (expected: number, next: WorkspaceState) => { if (expected !== revision) return false; state = structuredClone(next); revision++; return true; } };
}
function context(data: ReturnType<typeof backend>, request: GmailSyncContext['gmail']['request'], cursor = connection()): GmailSyncContext { return { connection: cursor, backend: data, gmail: { request }, signal: new AbortController().signal }; }
function requests(message: Awaited<ReturnType<typeof signed>>, ids = ['message1']): GmailSyncContext['gmail']['request'] {
  return async <T>(path: string, query?: Record<string, string>): Promise<T> => {
    if (path === 'profile') return { historyId: '100' } as T;
    if (path === 'messages') return { messages: ids.map(id => ({ id })) } as T;
    if (path === 'history') return { historyId: '101' } as T;
    const id = path.split('/')[1];
    return (query?.format === 'raw' ? { id, raw: message.raw.toString('base64url') } : { id, internalDate: String(now.getTime()), payload: message.payload }) as T;
  };
}

test('DKIM verifies body and signed sender/recipient; fabricated authentication headers have no authority', async () => {
  const message = await signed();
  const proof = await verifySender(message.raw, 'candidate@example.com', received, new AbortController().signal, resolver);
  assert.equal(proof.verified, true);
  assert.equal(associatedSender(proof, app()), true);
  assert.equal(associatedSender(proof, app({ recruiterEmail: '', url: 'https://greenhouse.io/jobs/1' })), false);
  const forged = Buffer.from(message.raw.toString().replace('Please complete your assessment.', 'We are not moving forward.'));
  assert.equal((await verifySender(forged, 'candidate@example.com', received, new AbortController().signal, resolver)).verified, false);
  const unsigned = Buffer.from(`Authentication-Results: mx.google.com; dkim=pass; spf=pass\r\n${message.raw.toString().replace(/^DKIM-Signature:[\s\S]+?(?=From:)/, '')}`);
  assert.equal((await verifySender(unsigned, 'candidate@example.com', received, new AbortController().signal, resolver)).verified, false);
});
test('unsigned critical headers, body length limits, recipient replay, and duplicate From cannot authorize changes', async () => {
  for (const message of [await signed({ headers: ['From', 'To', 'Date', 'Message-ID'] }), await signed({ maxBodyLength: 10 }), await signed({ to: 'another@example.com' }), await signed({ domain: 'evil.example' })]) assert.equal((await verifySender(message.raw, 'candidate@example.com', received, new AbortController().signal, resolver)).verified, false);
  const message = await signed();
  assert.equal((await verifySender(Buffer.concat([Buffer.from('From: attacker@example.com\r\n'), message.raw]), 'candidate@example.com', received, new AbortController().signal, resolver)).verified, false);
  assert.equal((await verifySender(new Uint8Array(MAX_RAW_BYTES + 1), 'candidate@example.com', received, new AbortController().signal, resolver)).verified, false);
  assert.equal(validDkimQuery('a._domainkey.northstar.example'), true);
  for (const query of ['https://evil.test', 'x._domainkey.localhost', 'x._domainkey.a..com', `${'a'.repeat(64)}._domainkey.example.com`]) assert.equal(validDkimQuery(query), false);
});
test('verified associated mail updates tasks through the shared event pipeline and retries do not duplicate', async () => {
  const message = await signed(); const data = backend(); const ctx = context(data, requests(message));
  const first = await syncConnection(ctx, { resolver });
  assert.equal(first.imported, 1); assert.equal(first.more, false);
  assert.equal(data.state.applications[0].stage, 'assessment'); assert.equal(data.state.applications[0].tasks.length, 1);
  assert.equal(data.state.applications[0].evidence[0].review, 'accepted');
  await syncConnection(ctx, { resolver });
  assert.equal(data.state.applications[0].evidence.length, 1); assert.equal(data.state.applications[0].tasks.length, 1);
  const replay = context(data, requests(message, ['differentGmailId']), connection());
  await syncConnection(replay, { resolver });
  assert.equal(data.state.applications[0].evidence.length, 1);
});
test('unverified, unrelated and ambiguous email never automatically mutates application state', async () => {
  const message = await signed(); message.raw = Buffer.from(message.raw.toString().replace('assessment.', 'assessment now.'));
  const data = backend(); const result = await syncConnection(context(data, requests(message)), { resolver });
  assert.equal(result.queued, 1); assert.equal(data.state.applications[0].stage, 'applied'); assert.equal(data.state.applications[0].tasks.length, 0);
  assert.equal(data.state.applications[0].evidence[0].review, 'pending');
  const verified = await signed(); const unrelated = backend([app({ recruiterEmail: 'other@different.example', url: 'https://different.example/job' })]);
  await syncConnection(context(unrelated, requests(verified)), { resolver }); assert.equal(unrelated.state.applications[0].stage, 'applied');
  const ambiguous = backend([app(), app({ id: 'app2' })]);
  await syncConnection(context(ambiguous, requests(verified)), { resolver });
  assert.equal(ambiguous.state.metadata.filter(item => item.key.startsWith('email-review:')).length, 1);
  assert.equal(ambiguous.state.applications.flatMap(app => app.evidence).length, 0);
});
test('workspace CAS conflicts rematch against current user edits and keep terminal stages reviewable', async () => {
  const message = await signed(); const data = backend(); const commit = data.commitWorkspace; let conflicts = 0;
  data.commitWorkspace = async (revision, state) => { if (!conflicts++) { data.state.applications[0].stage = 'withdrawn'; return false; } return commit(revision, state); };
  await syncConnection(context(data, requests(message)), { resolver });
  assert.equal(data.state.applications[0].stage, 'withdrawn'); assert.equal(data.state.applications[0].evidence[0].review, 'pending'); assert.equal(data.state.applications[0].tasks.length, 0);
});
test('partial initial pages resume exact IDs and recover expired history using the fixed original window', async () => {
  const message = await signed(); const data = backend(); const calls: Array<[string, Record<string, string> | undefined]> = [];
  const request: GmailSyncContext['gmail']['request'] = async <T>(path: string, query?: Record<string, string>) => { calls.push([path, query]); if (path === 'history' && query?.startHistoryId === '1') throw new GmailHttpError(404, 'unavailable'); return requests(message, ['one', 'two', 'three'])<T>(path, query); };
  const initial = connection({ phase: 'history', historyId: '1' });
  const first = await syncConnection(context(data, request, initial), { resolver, maxMessages: 1 });
  assert.deepEqual(first.pendingMessageIds, ['two', 'three']); assert.equal(first.phase, 'initial');
  assert.equal(calls.find(([path]) => path === 'messages')?.[1]?.q.includes(`after:${Math.floor(Date.parse(initial.syncAfter) / 1000)}`), true);
  const second = await syncConnection(context(data, request, { ...initial, ...first }), { resolver, maxMessages: 1 });
  assert.deepEqual(second.pendingMessageIds, ['three']);
  const third = await syncConnection(context(data, request, { ...initial, ...second }), { resolver }); assert.equal(third.more, false); assert.equal(third.historyId, '101');
  assert.equal(calls.filter(([path]) => path === 'messages').length, 1);
  assert.equal(calls.filter(([path]) => path === 'profile').length, 1);
});
test('oversized and deleted messages do not stall cursor advancement or claim verified updates', async () => {
  const data = backend(); const message = await signed();
  const request: GmailSyncContext['gmail']['request'] = async <T>(path: string, query?: Record<string, string>) => {
    if (path === 'messages/gone') throw new GmailHttpError(404, 'unavailable');
    if (path === 'messages/large' && query?.format !== 'metadata') throw new GmailHttpError(502, 'response_too_large');
    return requests(message, ['gone', 'large'])<T>(path, query);
  };
  const result = await syncConnection(context(data, request), { resolver });
  assert.equal(result.more, false); assert.equal(result.imported, 0); assert.equal(data.state.applications[0].stage, 'applied');
  assert.equal(data.state.metadata.filter(item => item.key.startsWith('email-seen:')).length, 2);
});

test('initial and history pagination retain the starting cursor until every page is consumed', async () => {
  const message = await signed(); const data = backend(); const queries: Record<string, string>[] = [];
  const request: GmailSyncContext['gmail']['request'] = async <T>(path: string, query?: Record<string, string>) => {
    if (path === 'messages') return (query?.pageToken === 'initial-next' ? { messages: [{ id: 'second' }] } : { messages: [{ id: 'first' }], nextPageToken: 'initial-next' }) as T;
    if (path === 'history') { queries.push(query!); return (query?.pageToken === 'history-next' ? { history: [{ messagesAdded: [{ message: { id: 'fourth' } }] }], historyId: '105' } : { history: [{ messagesAdded: [{ message: { id: 'third' } }] }], nextPageToken: 'history-next', historyId: '104' }) as T; }
    return requests(message)<T>(path, query);
  };
  let cursor = connection();
  for (let i = 0; i < 4; i++) {
    const result = await syncConnection(context(data, request, cursor), { resolver, maxMessages: 1 });
    cursor = { ...cursor, ...result };
    if (i === 0) { assert.equal(result.pageToken, 'initial-next'); assert.equal(result.baselineHistoryId, '100'); }
    if (i === 2) { assert.equal(result.historyId, '100'); assert.equal(result.pageToken, 'history-next'); }
    if (i === 3) { assert.equal(result.historyId, '105'); assert.equal(result.more, false); }
  }
  assert.deepEqual(queries.map(query => query.startHistoryId), ['100', '100']);
  assert.equal(data.state.metadata.filter(item => item.key.startsWith('email-seen:inbox1:')).length, 4);
});
test('CAS retry rechecks sender association and failed commits never advance progress', async () => {
  const message = await signed(); const data = backend(); const commit = data.commitWorkspace; let changed = false;
  data.commitWorkspace = async (revision, state) => {
    if (!changed) { changed = true; data.state.applications[0].recruiterEmail = 'other@different.example'; data.state.applications[0].url = 'https://different.example/job'; return false; }
    return commit(revision, state);
  };
  const result = await syncConnection(context(data, requests(message)), { resolver });
  assert.equal(result.queued, 1); assert.equal(data.state.applications[0].stage, 'applied');
  const refused = backend(); refused.commitWorkspace = async () => false;
  await assert.rejects(syncConnection(context(refused, requests(message)), { resolver }), /workspace is busy/);
  assert.equal(refused.state.metadata.length, 0); assert.equal(refused.state.applications[0].evidence.length, 0);
});
test('oversized history pages fail without silently dropping message IDs', async () => {
  const data = backend();
  const request: GmailSyncContext['gmail']['request'] = async <T>() => ({ historyId: '200', history: [{ messagesAdded: Array.from({ length: 1001 }, (_, i) => ({ message: { id: `message${i}` } })) }] } as T);
  const cursor = connection({ phase: 'history', historyId: '100' });
  await assert.rejects(syncConnection(context(data, request, cursor)), /too large/);
  assert.equal(cursor.historyId, '100'); assert.equal(data.state.metadata.length, 0);
});

test('shared ATS sender addresses and DNS claims never establish employer tenancy', async () => {
  const message = await signed({ domain: 'greenhouse.io', from: ['noreply', 'greenhouse.io'].join('@') });
  const proof = await verifySender(message.raw, 'candidate@example.com', received, new AbortController().signal, resolver);
  assert.equal(proof.verified, true);
  assert.equal(associatedSender(proof, app({ recruiterEmail: ['noreply', 'greenhouse.io'].join('@'), url: 'https://boards.greenhouse.io/northstar' })), false);
  const original = globalThis.fetch; const calls: string[] = [];
  try {
    globalThis.fetch = async input => { calls.push(String(input)); return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 16, data: '\"v=DKIM1; \" \"p=example\"' }] })); };
    const resolve = dnsResolver(new AbortController().signal);
    assert.deepEqual(await resolve('test._domainkey.northstar.example', 'TXT'), [['v=DKIM1; ', 'p=example']]);
    assert.equal(new URL(calls[0]).origin, 'https://cloudflare-dns.com');
    await assert.rejects(resolve('https://attacker.test/key', 'TXT'));
    await assert.rejects(resolve('test._domainkey.northstar.example', 'A'));
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => new Response('x'.repeat(65537));
    await assert.rejects(resolve('test._domainkey.northstar.example', 'TXT'), /too large/);
  } finally { globalThis.fetch = original; }
});

test('draft, sent, spam and trash messages never become delivered hiring updates', async () => {
  const message = await signed();
  for (const label of ['DRAFT', 'SENT', 'SPAM', 'TRASH']) {
    const data = backend();
    const request: GmailSyncContext['gmail']['request'] = async <T>(path: string, query?: Record<string, string>) => {
      const response = await requests(message)<Record<string, unknown>>(path, query);
      return (path.startsWith('messages/') ? { ...response, labelIds: [label] } : response) as T;
    };
    const result = await syncConnection(context(data, request), { resolver });
    assert.equal(result.imported, 0); assert.equal(result.queued, 0); assert.equal(data.state.applications[0].evidence.length, 0);
  }
});
test('signed replay cannot duplicate an unmatched review item or cross an account boundary', async () => {
  const message = await signed(); const data = backend([]);
  const first = await syncConnection(context(data, requests(message)), { resolver });
  assert.equal(first.queued, 1);
  const replay = await syncConnection(context(data, requests(message, ['replayed'])), { resolver });
  assert.equal(replay.queued, 0); assert.equal(data.state.metadata.filter(item => item.key.startsWith('email-review:')).length, 1);
  const other = backend();
  await syncConnection(context(other, requests(message), connection({ email: 'someone-else@example.com', id: 'another-inbox', userId: 'other-owner' })), { resolver });
  assert.equal(other.state.applications[0].stage, 'applied'); assert.equal(other.state.applications[0].tasks.length, 0);
});
