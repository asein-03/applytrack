import type { Express } from 'express';
import { z } from 'zod';
import type { CloudService } from './cloud.js';
import { HttpError } from './store.js';
import { cloudGmail } from './gmail-cloud.js';

const deletion = z.object({ confirmation: z.literal('DELETE'), password: z.string().min(1).max(1024) }).strict();
const deleted = z.object({ deleted: z.literal(true), revocationPending: z.boolean() });

export function attachAccountRoutes(app: Express, cloud: CloudService) {
  app.delete('/api/cloud/account', async (request, response) => {
    if (!cloud.enabled) throw new HttpError(409, 'Account deletion is unavailable in the demo workspace.');
    if (!request.is('application/json')) throw new HttpError(415, 'Use application/json for this request.');
    const input = deletion.parse(request.body);
    const actor = await cloud.verify(request.get('authorization')?.replace(/^Bearer /, '') ?? '');
    if (cloud.runtime.getMeta('activeCloudUser') !== actor.id) throw new HttpError(409, 'Sign in to this account on this device before deleting it.');
    let result: Response;
    try {
      result = await fetch(`${cloud.url}/functions/v1/account`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${actor.accessToken}`, apikey: cloud.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', ...input }),
      });
    } catch { throw new HttpError(503, 'Account deletion could not be confirmed. Check your connection and try again.'); }
    if (!result.ok) {
      await result.body?.cancel();
      const messages: Record<number, string> = { 401: 'Your session expired. Sign in again.', 403: 'Your password could not be confirmed. Try again.', 429: 'Too many attempts. Wait a moment and try again.' };
      throw new HttpError([401, 403, 429].includes(result.status) ? result.status : 503, messages[result.status] || 'Account deletion did not finish. Your data may be partially removed. Try again to finish.');
    }
    const reader = result.body?.getReader();
    let body = ''; let size = 0;
    try {
      if (!reader) throw new Error('Empty response');
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 4096) { await reader.cancel(); throw new Error('Large response'); }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } catch { throw new HttpError(502, 'Account deletion could not be confirmed. Try again.'); }
    finally { reader?.releaseLock(); }
    let output: z.infer<typeof deleted>;
    try { output = deleted.parse(JSON.parse(body)); }
    catch { throw new HttpError(502, 'Account deletion could not be confirmed. Try again.'); }
    // A different account may have signed in while the cloud removed this one.
    if (cloud.runtime.getMeta('activeCloudUser') === actor.id) cloud.unbind(actor.id);
    for (const item of cloud.runtime.listMeta(`user:${actor.id}:`)) cloud.runtime.deleteMeta(item.key);
    cloud.runtime.deleteMeta(`cloud-session:${actor.id}`);
    cloudGmail(cloud).forgetAccount(actor.id);
    response.json(output);
  });
}
