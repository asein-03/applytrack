import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { extractBody, type GmailPart } from '../../../shared/email-body.ts';
import { classifyEmail, emailEvent, matchEmail, type IncomingEmail } from '../../../shared/email-parser.ts';
import { ingestEvent } from '../../../shared/events.ts';
import { HttpError } from '../../../shared/errors.ts';
import { associatedSender, MAX_RAW_BYTES, verifySender, type SenderProof } from './sender.ts';
import { MemoryWorkspace } from './workspace.ts';
import { GmailHttpError, type GmailSyncContext, type GmailSyncCursor, type GmailSyncResult } from './shared.ts';

type Message = { id: string; internalDate: string; labelIds?: string[]; payload?: GmailPart; raw?: string };
type Batch = { messages?: Array<{ id: string }>; nextPageToken?: string };
type History = { history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>; nextPageToken?: string; historyId: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
const token = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.length || value.length > 4096) throw new GmailHttpError(502, 'invalid_response');
  return value;
};
const seenKey = (connection: GmailSyncContext['connection'], id: string) => `email-seen:${connection.id}:${id}`;
const relevant = '{application assessment interview "coding challenge" "job offer" "employment offer"}';
interface SyncOptions { maxMessages?: number; resolver?: Parameters<typeof verifySender>[4]; }

async function fetchMail(context: GmailSyncContext, id: string, options: SyncOptions): Promise<{ mail: IncomingEmail; proof: SenderProof } | null> {
  const { gmail, connection, signal } = context;
  let message: Message; let limited = false;
  try { message = await gmail.request<Message>(`messages/${id}`, { format: 'full' }); }
  catch (error) {
    if (error instanceof GmailHttpError && error.status === 404) return null;
    if (!(error instanceof GmailHttpError) || error.code !== 'response_too_large') throw error;
    limited = true;
    try { message = await gmail.request<Message>(`messages/${id}`, { format: 'metadata' }); }
    catch (fallback) { if (fallback instanceof GmailHttpError && (fallback.status === 404 || fallback.code === 'response_too_large')) return null; throw fallback; }
  }
  if (message.labelIds?.some(label => ['DRAFT', 'SENT', 'SPAM', 'TRASH'].includes(label))) return null;
  if (message.id !== id || !message.payload || !Array.isArray(message.payload.headers)) throw new GmailHttpError(502, 'invalid_response');
  const header = (key: string) => message.payload!.headers!.find(item => typeof item.name === 'string' && item.name.toLowerCase() === key)?.value?.slice(0, 8000) ?? '';
  const received = Number(message.internalDate);
  if (!Number.isFinite(received) || received < 0 || received > Date.now() + 86400000) throw new GmailHttpError(502, 'invalid_response');
  const mail: IncomingEmail = { id, from: header('from'), subject: header('subject'), body: limited ? 'Message content is too large. Open Gmail to review it.' : extractBody(message.payload).slice(0, 50000), receivedAt: new Date(received).toISOString(), workspace: 'personal', inboxId: connection.id, recipient: connection.email };
  let proof: SenderProof = { verified: false, reason: limited ? 'Message content is too large to verify.' : 'Sender signature could not be verified.' };
  if (!limited && (classifyEmail(mail).kind !== 'note')) {
    try {
      const raw = await gmail.request<Message>(`messages/${id}`, { format: 'raw' });
      if (raw.id === id && typeof raw.raw === 'string' && raw.raw.length <= Math.ceil(MAX_RAW_BYTES / 3) * 4 && /^[A-Za-z0-9_-]*={0,2}$/.test(raw.raw)) {
        proof = await verifySender(Buffer.from(raw.raw, 'base64url'), connection.email, mail.receivedAt, signal, options.resolver);
        // Both Gmail representations must describe the same signed headers.
        if (proof.verified && Object.entries(proof.headers).some(([key, value]) => header(key).replace(/\r?\n[ \t]+/g, ' ').trim() !== value)) proof = { verified: false, reason: 'The displayed message headers differ from its signature.' };
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof GmailHttpError) || ![404].includes(error.status) && error.code !== 'response_too_large') throw error;
    }
  }
  return { mail, proof };
}

async function processMessage(context: GmailSyncContext, id: string, options: SyncOptions): Promise<'imported' | 'queued' | 'seen'> {
  let snapshot = await context.backend.readWorkspace();
  if (snapshot.state.metadata.some(item => item.key === seenKey(context.connection, id))) return 'seen';
  const content = await fetchMail(context, id, options);
  for (let attempt = 0; attempt < 5; attempt++) {
    context.signal.throwIfAborted();
    const store = new MemoryWorkspace(snapshot.state);
    const key = seenKey(context.connection, id);
    if (store.getMeta(key)) return 'seen';
    let outcome: 'imported' | 'queued' | 'seen' = 'seen';
    let audit: Record<string, unknown> = { verdict: 'unavailable', reason: 'Message was removed, is not delivered recruiting mail, or could not be read within the size limit.' };
    const replayKey = content?.proof.verified ? `email-seen:signature:${content.proof.signature}` : null;
    const replay = replayKey ? store.getMeta<Record<string, unknown>>(replayKey) : null;
    if (replay) audit = { ...replay, verdict: 'duplicate', reason: 'This signed message was already handled.' };
    else if (content) {
      const { mail, proof } = content;
      const classification = classifyEmail(mail);
      const application = matchEmail(mail, store.listApplications('personal'));
      audit = { verdict: proof.verified ? 'verified' : 'unverified', reason: proof.reason, ...(proof.verified ? { domain: proof.domain, signature: proof.signature, messageId: proof.messageId } : {}) };
      if (classification.kind !== 'note' || application) {
        if (!application) {
          const reviewId = hash(`${mail.workspace}:${mail.inboxId}:${mail.id}`);
          store.setMeta(`email-review:${reviewId}`, { ...mail, id: reviewId, originalId: mail.id, kind: classification.kind });
          outcome = 'queued'; audit.reviewId = reviewId;
        } else {
          const automatic = associatedSender(proof, application) && !classification.requiresReview;
          const event = emailEvent(mail, application);
          event.requiresReview = !automatic;
          if (proof.verified) { event.sourceId = `email:signature:${proof.signature}`; event.observedAt = proof.date; }
          event.excerpt = `${mail.from}\n${automatic ? 'Verified sender associated with this application.' : proof.verified ? 'Verified sender needs application review.' : proof.reason}\n${mail.subject}\n${mail.body}`.slice(0, 8000);
          try {
            const result = ingestEvent(store, event);
            outcome = result.evidence.review === 'accepted' ? 'imported' : 'queued';
            audit = { ...audit, applicationId: result.application.id, evidenceId: result.evidence.id, verdict: result.evidence.review === 'accepted' ? 'accepted' : 'review' };
          } catch (error) {
            if (!(error instanceof HttpError) || ![409, 410].includes(error.status)) throw error;
            audit = { ...audit, verdict: 'duplicate', reason: 'This signed message was already handled or its application was deleted.' };
          }
        }
      } else audit.verdict = 'irrelevant';
    }
    store.setMeta(key, audit);
    if (replayKey && !replay) store.setMeta(replayKey, audit);
    if (await context.backend.commitWorkspace(snapshot.revision, store.state)) return outcome;
    snapshot = await context.backend.readWorkspace();
  }
  throw new GmailHttpError(409, 'unavailable', 'The workspace is busy. Sync will retry.');
}
function cursorFrom(context: GmailSyncContext): GmailSyncCursor {
  const { phase, historyId, pageToken, baselineHistoryId, pendingMessageIds, pendingNextPageToken, pendingHistoryId } = context.connection;
  if (!['initial', 'history'].includes(phase) || !Array.isArray(pendingMessageIds) || pendingMessageIds.length > 1000 || pendingMessageIds.some(id => !validId(id))) throw new GmailHttpError(502, 'invalid_response');
  return { phase, historyId, pageToken, baselineHistoryId, pendingMessageIds: [...pendingMessageIds], pendingNextPageToken, pendingHistoryId };
}
async function nextPage(context: GmailSyncContext, cursor: GmailSyncCursor): Promise<void> {
  if (cursor.phase === 'initial') {
    if (!cursor.baselineHistoryId) {
      const profile = await context.gmail.request<{ historyId: string }>('profile');
      if (!/^\d{1,40}$/.test(profile.historyId)) throw new GmailHttpError(502, 'invalid_response');
      cursor.baselineHistoryId = profile.historyId;
    }
    const since = Math.floor(Date.parse(context.connection.syncAfter) / 1000);
    if (!Number.isFinite(since)) throw new GmailHttpError(502, 'invalid_response');
    const batch = await context.gmail.request<Batch>('messages', { q: `after:${since} ${relevant}`, maxResults: '100', ...(cursor.pageToken ? { pageToken: cursor.pageToken } : {}) });
    const messages = batch.messages ?? [];
    if (!Array.isArray(messages) || messages.length > 1000 || messages.some(message => !validId(message.id))) throw new GmailHttpError(502, 'invalid_response');
    cursor.pendingMessageIds = [...new Set(messages.map(message => message.id))];
    cursor.pendingNextPageToken = token(batch.nextPageToken);
    cursor.pendingHistoryId = cursor.baselineHistoryId;
  } else {
    if (!cursor.historyId || !/^\d{1,40}$/.test(cursor.historyId)) throw new GmailHttpError(502, 'invalid_response');
    try {
      const history = await context.gmail.request<History>('history', { startHistoryId: cursor.historyId, historyTypes: 'messageAdded', maxResults: '10', ...(cursor.pageToken ? { pageToken: cursor.pageToken } : {}) });
      if (!/^\d{1,40}$/.test(history.historyId) || !Array.isArray(history.history ?? [])) throw new GmailHttpError(502, 'invalid_response');
      const ids = (history.history ?? []).flatMap(item => (item.messagesAdded ?? []).map(entry => entry.message?.id));
      if (ids.some(id => !validId(id)) || ids.length > 1000) throw new GmailHttpError(502, 'invalid_response', 'This mailbox change is too large to process safely. Sync will retry without advancing.');
      cursor.pendingMessageIds = [...new Set(ids)]; cursor.pendingNextPageToken = token(history.nextPageToken); cursor.pendingHistoryId = history.historyId;
    } catch (error) {
      if (!(error instanceof GmailHttpError) || error.status !== 404) throw error;
      // Keep the original initial window. A moving window would lose unseen mail.
      Object.assign(cursor, { phase: 'initial', historyId: null, pageToken: null, baselineHistoryId: null, pendingMessageIds: [], pendingNextPageToken: null, pendingHistoryId: null });
      await nextPage(context, cursor);
    }
  }
}
function finishPage(cursor: GmailSyncCursor): boolean {
  cursor.pageToken = cursor.pendingNextPageToken;
  cursor.pendingNextPageToken = null;
  if (cursor.pageToken) { cursor.pendingHistoryId = null; return false; }
  cursor.historyId = cursor.pendingHistoryId;
  cursor.pendingHistoryId = null;
  if (cursor.phase === 'initial') { cursor.phase = 'history'; cursor.baselineHistoryId = null; return false; }
  return true;
}
export async function syncConnection(context: GmailSyncContext, options: SyncOptions = {}): Promise<GmailSyncResult> {
  const cursor = cursorFrom(context);
  let processed = 0; let imported = 0; let queued = 0; let pages = 0; let complete = false;
  const started = Date.now(); const maximum = Math.max(1, Math.min(20, options.maxMessages ?? 10));
  while (processed < maximum && pages < 5 && Date.now() - started < 20000) {
    context.signal.throwIfAborted();
    if (!cursor.pendingMessageIds.length) {
      if (cursor.pendingHistoryId) { complete = finishPage(cursor); if (complete) break; }
      await nextPage(context, cursor); pages++;
      if (!cursor.pendingMessageIds.length) { complete = finishPage(cursor); if (complete) break; continue; }
    }
    const id = cursor.pendingMessageIds[0];
    const outcome = await processMessage(context, id, options);
    cursor.pendingMessageIds.shift(); processed++;
    if (outcome === 'imported') imported++; else if (outcome === 'queued') queued++;
  }
  if (!cursor.pendingMessageIds.length && cursor.pendingHistoryId) complete = finishPage(cursor);
  return { ...cursor, processed, imported, queued, more: !complete };
}
