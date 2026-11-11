import express, { type ErrorRequestHandler, type Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { STAGES, type CaptureEvent, type Inbox, type Workspace } from '../shared/types.js';
import { HttpError, Store } from './store.js';
import { ingestEvent, reviewEvidence } from './events.js';
import { seedDemo } from './seed.js';
import { CloudService, WorkspaceRepository, type CloudActor } from './cloud.js';
import { attachLibraryRoutes } from './library.js';
import { attachReminderRoutes } from './reminders.js';
import { archiveDocument, attachmentFilename, downloadDocument, drainDocumentDeletions, MAX_COPY_BYTES, MAX_DOCUMENT_BYTES, prepareDocumentCapture } from './documents.js';

const text = (limit = 500) => z.string().trim().max(limit);
const requiredText = (limit = 500) => text(limit).min(1);
const date = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
const url = text(4000).refine(value => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }, 'Use an http or https URL.');
const optionalUrl = z.union([z.literal(''), url]);
const workspace = z.enum(['personal', 'demo']);
const applicationShape = {
  company: requiredText(200), role: requiredText(300), stage: z.enum(STAGES), location: text(300), workMode: text(100),
  salary: text(200), url: optionalUrl, jobId: text(300), description: text(100_000), email: text(320),
  resumeName: text(500), coverLetterName: text(500), recruiterName: text(200), recruiterEmail: text(320),
  notes: text(30_000), priority: z.enum(['normal', 'high']), appliedAt: date.nullable(),
};
const createApplicationSchema = z.object(applicationShape).partial().extend({ company: applicationShape.company, role: applicationShape.role, workspace: workspace.optional() }).strict();
const patchApplicationSchema = z.object(applicationShape).partial().strict().refine(value => Object.keys(value).length > 0, 'Provide a field to update.');
const taskSchema = z.object({ title: requiredText(500), dueAt: date.nullable().optional(), url: optionalUrl.nullable().optional() }).strict();
const taskPatchSchema = taskSchema.partial().extend({ completedAt: date.nullable().optional() }).strict().refine(value => Object.keys(value).length > 0, 'Provide a field to update.');
export const documentFileSchema = z.object({ kind: z.enum(['resume', 'cover_letter']), name: requiredText(500), size: z.number().int().min(0).max(MAX_DOCUMENT_BYTES), mimeType: text(200), lastModified: z.number().int().min(0).max(8640000000000000), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();

function validSnapshot(value: string): boolean {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length < 12 || bytes.length > 2 * 1024 * 1024) return false;
  if (match[1] === 'png') return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (match[1] === 'jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}
export const captureEventSchema = z.object({
  applicationId: requiredText(100).optional(), workspace: workspace.optional(), company: requiredText(200).optional(), role: requiredText(300).optional(),
  url: optionalUrl.optional(), jobId: text(300).optional(), description: text(100_000).optional(), location: text(300).optional(), email: text(320).optional(),
  source: z.enum(['browser', 'visual', 'email', 'manual']),
  kind: z.enum(['submission_pending', 'submission_confirmed', 'assessment_requested', 'assessment_completed', 'interview', 'offer', 'rejection', 'note', 'document_selected', 'document_removed']),
  summary: requiredText(1000), excerpt: text(30_000).optional(), observedAt: date.optional(), sourceId: requiredText(1000).optional(),
  snapshot: z.string().max(2_800_000).refine(validSnapshot, 'Use a PNG, JPEG, or WebP image smaller than 2 MB.').optional(),
  requiresReview: z.boolean().optional(), task: taskSchema.optional(),
  document: documentFileSchema.extend({ contentBase64: z.string().max(Math.ceil(MAX_COPY_BYTES / 3) * 4).optional() }).strict().optional(),
  documents: z.array(documentFileSchema).max(2).optional(),
}).strict().superRefine((value, context) => {
  const docEvent = value.kind === 'document_selected' || value.kind === 'document_removed';
  if ((docEvent || value.document || value.documents) && value.source !== 'browser') context.addIssue({ code: 'custom', message: 'Document detection is only accepted from browser tracking.' });
  if (docEvent && !value.document) context.addIssue({ code: 'custom', message: 'Document details are required.' });
  if (value.document && !docEvent) context.addIssue({ code: 'custom', message: 'Document details require a selection or removal event.' });
  if (value.document?.contentBase64 !== undefined && value.kind !== 'document_selected') context.addIssue({ code: 'custom', message: 'File content is only accepted on selection.' });
  if (value.documents && !['submission_pending', 'submission_confirmed'].includes(value.kind)) context.addIssue({ code: 'custom', message: 'Document snapshots require a submission event.' });
  if (value.documents && new Set(value.documents.map(file => file.kind)).size !== value.documents.length) context.addIssue({ code: 'custom', message: 'Only one document of each kind can be included in a submission.' });
});

const safeTokenEqual = (actual: string, expected: string) => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return expectedBytes.length > 0 && actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

export const apiErrorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof z.ZodError) { response.status(422).json({ error: error.issues.map(issue => `${issue.path.join('.') || 'Request'}: ${issue.message}`).join(' ') }); return; }
  if (error instanceof HttpError) { response.status(error.status).json({ error: error.message }); return; }
  if (error?.type === 'entity.too.large') { response.status(413).json({ error: 'Request is too large.' }); return; }
  if (error instanceof SyntaxError && 'body' in error) { response.status(400).json({ error: 'Request body must be valid JSON.' }); return; }
  console.error('API request failed:', error instanceof Error ? error.message : 'Unknown error');
  response.status(500).json({ error: 'The request could not be completed.' });
};

export function createApp(options: { dbPath?: string; cloud?: CloudService; repository?: WorkspaceRepository } = {}) {
  const store = options.cloud?.runtime ?? new Store(options.dbPath ?? resolve(process.env.DATA_DIR ?? 'data', 'apply.sqlite'));
  seedDemo(store);
  const cloud = options.cloud ?? new CloudService(store, resolve(process.env.DATA_DIR ?? 'data'), !options.dbPath && process.env.APP_STORAGE_MODE !== 'local');
  const repository = options.repository ?? new WorkspaceRepository(store, cloud);
  const actorFor = (request: Request, workspace: Workspace = 'personal'): Promise<CloudActor | null> => cloud.enabled && workspace === 'personal' ? cloud.authenticate(request) : Promise.resolve(null);
  const runtimeFor = (actor: CloudActor | null) => actor ? cloud.runtimeFor(actor) : store;
  const workspaceForId = (id: string): Workspace => store.getApplication(id)?.workspace === 'demo' ? 'demo' : 'personal';
  const run = async <T>(request: Request, workspace: Workspace, write: boolean, action: (data: Store) => T | Promise<T>) => repository.run(workspace, await actorFor(request, workspace), write, action);
  const app = express();
  app.disable('x-powered-by');
  const allowedOrigins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4318', 'http://localhost:4318']);
  const configuredPort = Number(process.env.PORT ?? 4318);
  if (Number.isInteger(configuredPort) && configuredPort >= 1024 && configuredPort <= 65535) {
    allowedOrigins.add(`http://127.0.0.1:${configuredPort}`);
    allowedOrigins.add(`http://localhost:${configuredPort}`);
  }
  const configuredOrigin = process.env.APP_ORIGIN;
  if (configuredOrigin) {
    try { const parsed = new URL(configuredOrigin); if (['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && parsed.protocol === 'http:') allowedOrigins.add(parsed.origin); } catch { /* Invalid configuration is not made trusted. */ }
  }
  app.use('/api', (request, response, next) => {
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(request.get('host') ?? '')) { response.status(403).json({ error: 'This API only accepts local requests.' }); return; }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = request.get('origin');
    const fromExtension = !!origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    const token = request.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const tokenValid = safeTokenEqual(token, store.getMeta<string>('extensionToken') ?? '');
    response.locals.companion = tokenValid;
    if (tokenValid) {
      const route = `${request.method} ${request.originalUrl.split('?')[0]}`;
      if (!['GET /api/health', 'GET /api/sessions/current', 'POST /api/sessions', 'DELETE /api/sessions/current', 'POST /api/events'].includes(route)) { response.status(403).json({ error: 'The browser companion can only capture applications and control tracking.' }); return; }
    }
    if (origin && !allowedOrigins.has(origin) && !fromExtension) { response.status(403).json({ error: 'This origin cannot access your tracker.' }); return; }
    if (request.method === 'OPTIONS') {
      if (!origin || (!allowedOrigins.has(origin) && !fromExtension)) { response.sendStatus(403); return; }
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      response.sendStatus(204); return;
    }
    const publicHealth = request.method === 'GET' && request.originalUrl.split('?')[0] === '/api/health';
    if (fromExtension && !tokenValid && !publicHealth) { response.status(401).json({ error: 'Pair the browser extension with your tracker first.' }); return; }
    // Google redirects through a cross-site top-level GET. Its route separately
    // verifies the short-lived, one-use state, browser cookie and PKCE verifier.
    const oauthCallback = request.method === 'GET' && request.originalUrl.split('?')[0] === '/api/inboxes/google/callback';
    if (!origin && request.get('sec-fetch-site') === 'cross-site' && !oauthCallback) { response.status(403).json({ error: 'Cross-site requests are not allowed.' }); return; }
    if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
    if (['POST', 'PATCH', 'PUT'].includes(request.method) && (Number(request.get('content-length') ?? 0) > 0 || request.get('transfer-encoding')) && !request.is('application/json')) { response.status(415).json({ error: 'Use application/json for request bodies.' }); return; }
    next();
  });
  app.use('/api/events', express.json({ limit: '15mb' }));
  app.use('/api', express.json({ limit: '3mb' }));
  const getWorkspace = (query: unknown): Workspace => workspace.parse(query ?? 'personal');

  app.get('/api/health', (_req, res) => res.json({ ok: true, dashboardUrl: configuredOrigin && allowedOrigins.has(configuredOrigin) ? configuredOrigin : 'http://localhost:5173' }));
  app.get('/api/cloud/config', (_req, res) => res.json(cloud.config()));
  app.post('/api/cloud/session', async (req, res) => {
    if (!cloud.enabled) throw new HttpError(409, 'Cloud accounts are disabled in local test mode.');
    const input = z.object({ accessToken: z.string().min(1).max(16000), refreshToken: z.string().min(1).max(16000).optional() }).strict().parse(req.body);
    if (req.get('authorization') !== `Bearer ${input.accessToken}`) throw new HttpError(401, 'The account token does not match this request.');
    const actor = await cloud.bind(input.accessToken, input.refreshToken);
    res.json({ user: { id: actor.id, email: actor.email } });
  });
  app.delete('/api/cloud/session', async (req, res) => { const actor = await cloud.verify(req.get('authorization')?.replace(/^Bearer /, '') ?? ''); cloud.unbind(actor.id); res.sendStatus(204); });
  app.get('/api/applications', async (req, res) => {
    const workspace = getWorkspace(req.query.workspace); const actor = await actorFor(req, workspace);
    if (actor) await drainDocumentDeletions(repository, actor).catch(() => {});
    res.json({ applications: await repository.run(workspace, actor, false, data => data.listApplications(workspace)) });
  });
  app.get('/api/applications/:id', async (req, res) => res.json(await run(req, workspaceForId(req.params.id), false, data => data.requireApplication(req.params.id))));
  app.post('/api/applications', async (req, res) => { const input = createApplicationSchema.parse(req.body); res.status(201).json(await run(req, input.workspace ?? 'personal', true, data => data.createApplication(input))); });
  app.patch('/api/applications/:id', async (req, res) => { const patch = patchApplicationSchema.parse(req.body); res.json(await run(req, workspaceForId(req.params.id), true, data => data.updateApplication(req.params.id, patch))); });
  app.delete('/api/applications/:id', async (req, res) => {
    const workspace = workspaceForId(req.params.id); const actor = await actorFor(req, workspace);
    await repository.run(workspace, actor, true, data => {
      const application = data.getApplication(req.params.id);
      if (!application) {
        if (actor && data.getMeta(`document-deletion:${req.params.id}`)) return;
        throw new HttpError(404, 'Application not found.');
      }
      const hashes = [...new Set(application.documents?.filter(doc => doc.sha256).map(doc => doc.sha256!) ?? [])];
      if (actor && hashes.length) data.setMeta(`document-deletion:${application.id}`, { applicationId: application.id, hashes });
      data.deleteApplication(application.id);
    });
    if (actor) await drainDocumentDeletions(repository, actor, req.params.id);
    res.sendStatus(204);
  });
  app.post('/api/applications/:id/tasks', async (req, res) => { const input = taskSchema.parse(req.body); res.status(201).json(await run(req, workspaceForId(req.params.id), true, data => data.createTask(req.params.id, input))); });
  app.patch('/api/tasks/:id', async (req, res) => { const input = taskPatchSchema.parse(req.body); const workspace = store.listApplications('demo').some(app => app.tasks.some(task => task.id === req.params.id)) ? 'demo' : 'personal'; res.json(await run(req, workspace, true, data => data.updateTask(req.params.id, input))); });

  app.get('/api/sessions/current', async (req, res) => res.json({ session: runtimeFor(await actorFor(req)).getSession() }));
  app.post('/api/sessions', async (req, res) => {
    const body = z.object({ browserEnabled: z.boolean(), screenEnabled: z.boolean() }).strict().refine(value => value.browserEnabled || value.screenEnabled, 'Enable browser or screen tracking.').parse(req.body);
    const runtime = runtimeFor(await actorFor(req));
    if (res.locals.companion && body.screenEnabled && !runtime.getSession()?.screenEnabled) throw new HttpError(403, 'Start screen tracking from the dashboard.');
    res.status(201).json(runtime.startSession(body));
  });
  app.delete('/api/sessions/current', async (req, res) => { runtimeFor(await actorFor(req)).stopSession(); res.sendStatus(204); });
  app.get('/api/settings', async (req, res) => {
    const actor = cloud.enabled && !req.get('authorization') ? null : await actorFor(req); const runtime = runtimeFor(actor);
    res.json({ gmailConfigured: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET, inboxes: cloud.enabled && !actor ? [] : runtime.listInboxes().map(safeInbox), extensionToken: cloud.enabled && (!actor || store.getMeta('activeCloudUser') !== actor.id) ? '' : store.getMeta('extensionToken'), session: cloud.enabled && !actor ? null : runtime.getSession(), cloud: { enabled: cloud.enabled, configured: cloud.configured, user: actor ? { id: actor.id, email: actor.email } : null } });
  });
  app.get('/api/pairing', async (req, res) => { const actor = await actorFor(req); if (actor && store.getMeta('activeCloudUser') !== actor.id) throw new HttpError(409, 'Activate this account on the device before pairing.'); res.json({ token: store.getMeta('extensionToken') }); });
  app.post('/api/events', async (req, res) => {
    const prepared = prepareDocumentCapture(captureEventSchema.parse(req.body) as CaptureEvent); const input = prepared.input;
    if (res.locals.companion && ((input.workspace && input.workspace !== 'personal') || input.applicationId || !(input.source === 'browser' && ['submission_pending', 'submission_confirmed', 'document_selected', 'document_removed'].includes(input.kind) || input.source === 'manual' && input.kind === 'note'))) throw new HttpError(403, 'The browser companion can only send job captures.');
    const workspace = input.workspace ?? 'personal'; const actor = await actorFor(req, workspace);
    if (input.source === 'browser' || input.source === 'visual') {
      const session = runtimeFor(actor).getSession();
      if (!session || (input.source === 'browser' && !session.browserEnabled) || (input.source === 'visual' && !session.screenEnabled)) throw new HttpError(409, 'Start the appropriate tracking mode before sending capture evidence.');
    }
    let result = await repository.run(workspace, actor, true, data => ingestEvent(data, input));
    let archiveError: string | undefined = prepared.bytes && !result.evidence.documentId ? 'Review this evidence and select the file again to save its cloud copy.' : undefined;
    if (prepared.bytes && result.evidence.documentId) {
      const document = result.application.documents?.find(doc => doc.id === result.evidence.documentId);
      if (document && !document.stored) {
        if (!actor) archiveError = 'File copies require a signed-in cloud account.';
        else try {
          await archiveDocument(actor, result.application.id, document, prepared.bytes);
          result = await repository.run(workspace, actor, true, data => { const application = data.requireApplication(result.application.id); const saved = application.documents?.find(doc => doc.id === document.id); if (!saved) throw new HttpError(409, 'This application changed before the copy was saved.'); saved.stored = true; data.saveApplication(application); return { application, evidence: application.evidence.find(item => item.id === result.evidence.id)! }; });
        } catch (error) {
          archiveError = error instanceof HttpError ? error.message : 'The document name was recorded, but its cloud copy could not be saved.';
          // A delete may commit while the object upload is still in flight.
          // Preserve a cleanup request even when the original delete already drained it.
          if (document.sha256) {
            await repository.run(workspace, actor, true, data => {
              if (data.getApplication(result.application.id)) return;
              const key = `document-deletion:${result.application.id}`;
              const pending = data.getMeta<{ applicationId: string; hashes: string[] }>(key);
              data.setMeta(key, { applicationId: result.application.id, hashes: [...new Set([...(pending?.hashes ?? []), document.sha256!])] });
            });
            await drainDocumentDeletions(repository, actor, result.application.id).catch(() => {});
          }
        }
      }
    }
    if (res.locals.companion) {
      const documents = result.application.documents?.filter(document => document.id === result.evidence.documentId).map(({ id, name, kind, sha256, stored }) => ({ id, name, kind, sha256, stored })) ?? [];
      res.status(201).json({ application: { id: result.application.id, documents }, evidence: { id: result.evidence.id, documentId: result.evidence.documentId, review: result.evidence.review }, ...(archiveError ? { archiveError } : {}) });
    } else res.status(201).json({ ...result, ...(archiveError ? { archiveError } : {}) });
  });
  app.get('/api/applications/:id/documents/:documentId/file', async (req, res) => { const actor = await actorFor(req); if (!actor) throw new HttpError(404, 'File copies are available from a signed-in cloud account.'); const application = await repository.run('personal', actor, false, data => data.requireApplication(req.params.id)); const { bytes, document } = await downloadDocument(actor, application, req.params.documentId); res.attachment(attachmentFilename(document.name)); res.type('application/octet-stream'); res.send(bytes); });
  app.post('/api/evidence/:id/review', async (req, res) => { const { action } = z.object({ action: z.enum(['accept', 'dismiss']) }).strict().parse(req.body); const workspace = store.listApplications('demo').some(app => app.evidence.some(item => item.id === req.params.id)) ? 'demo' : 'personal'; res.json(await run(req, workspace, true, data => reviewEvidence(data, req.params.id, action))); });
  app.get('/api/export', async (req, res) => {
    const workspace = getWorkspace(req.query.workspace); const records = await run(req, workspace, false, data => data.listApplications(workspace));
    const headers = ['Company', 'Role', 'Stage', 'Applied', 'Location', 'Work arrangement', 'Salary', 'Job URL', 'Job ID', 'Email', 'CV', 'Cover letter', 'Recruiter', 'Recruiter email', 'Priority', 'Next action', 'Deadline', 'Notes'];
    const rows = records.map(record => {
      const nextTask = record.tasks.filter(task => !task.completedAt).sort((a,b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'))[0];
      return [record.company, record.role, record.stage, record.appliedAt ?? '', record.location, record.workMode, record.salary, record.url, record.jobId, record.email, record.resumeName, record.coverLetterName, record.recruiterName, record.recruiterEmail, record.priority, nextTask?.title ?? '', nextTask?.dueAt ?? '', record.notes];
    });
    res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="applications.csv"');
    res.send('\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n'));
  });
  attachLibraryRoutes(app, store, { cloud, repository });
  const reminders = attachReminderRoutes(app, store, { cloud, repository });
  app.use(apiErrorHandler);
  return { app, store, cloud, repository, reminders, close: () => store.close() };
}

function safeInbox(inbox: Inbox): Inbox {
  return { id: inbox.id, provider: 'gmail', email: inbox.email, status: inbox.status, lastSyncAt: inbox.lastSyncAt, error: inbox.error };
}
export function csvCell(value: string): string {
  // Spreadsheet applications execute formulas even inside quoted CSV cells.
  const safe = /^[\s]*[=+@\-\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
