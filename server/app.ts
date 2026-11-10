import express, { type ErrorRequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { STAGES, type CaptureEvent, type Inbox, type Workspace } from '../shared/types.js';
import { HttpError, Store } from './store.js';
import { ingestEvent, reviewEvidence } from './events.js';
import { seedDemo } from './seed.js';

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
  kind: z.enum(['submission_pending', 'submission_confirmed', 'assessment_requested', 'assessment_completed', 'interview', 'offer', 'rejection', 'note']),
  summary: requiredText(1000), excerpt: text(30_000).optional(), observedAt: date.optional(), sourceId: requiredText(1000).optional(),
  snapshot: z.string().max(2_800_000).refine(validSnapshot, 'Use a PNG, JPEG, or WebP image smaller than 2 MB.').optional(),
  requiresReview: z.boolean().optional(), task: taskSchema.optional(),
}).strict();

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

export function createApp(options: { dbPath?: string } = {}) {
  const store = new Store(options.dbPath ?? resolve(process.env.DATA_DIR ?? 'data', 'apply.sqlite'));
  seedDemo(store);
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
    if (origin && !allowedOrigins.has(origin) && !fromExtension) { response.status(403).json({ error: 'This origin cannot access your tracker.' }); return; }
    if (request.method === 'OPTIONS') {
      if (!origin || (!allowedOrigins.has(origin) && !fromExtension)) { response.sendStatus(403); return; }
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      response.sendStatus(204); return;
    }
    if (fromExtension && !tokenValid) { response.status(401).json({ error: 'Pair the browser extension with your tracker first.' }); return; }
    // Google redirects through a cross-site top-level GET. Its route separately
    // verifies the short-lived, one-use state, browser cookie and PKCE verifier.
    const oauthCallback = request.method === 'GET' && request.originalUrl.split('?')[0] === '/api/inboxes/google/callback';
    if (!origin && request.get('sec-fetch-site') === 'cross-site' && !oauthCallback) { response.status(403).json({ error: 'Cross-site requests are not allowed.' }); return; }
    if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
    if (['POST', 'PATCH', 'PUT'].includes(request.method) && (Number(request.get('content-length') ?? 0) > 0 || request.get('transfer-encoding')) && !request.is('application/json')) { response.status(415).json({ error: 'Use application/json for request bodies.' }); return; }
    next();
  });
  app.use('/api', express.json({ limit: '3mb' }));
  const getWorkspace = (query: unknown): Workspace => workspace.parse(query ?? 'personal');

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/applications', (req, res) => res.json({ applications: store.listApplications(getWorkspace(req.query.workspace)) }));
  app.get('/api/applications/:id', (req, res) => res.json(store.requireApplication(req.params.id)));
  app.post('/api/applications', (req, res) => res.status(201).json(store.createApplication(createApplicationSchema.parse(req.body))));
  app.patch('/api/applications/:id', (req, res) => res.json(store.updateApplication(req.params.id, patchApplicationSchema.parse(req.body))));
  app.delete('/api/applications/:id', (req, res) => { store.deleteApplication(req.params.id); res.sendStatus(204); });
  app.post('/api/applications/:id/tasks', (req, res) => res.status(201).json(store.createTask(req.params.id, taskSchema.parse(req.body))));
  app.patch('/api/tasks/:id', (req, res) => res.json(store.updateTask(req.params.id, taskPatchSchema.parse(req.body))));

  app.get('/api/sessions/current', (_req, res) => res.json({ session: store.getSession() }));
  app.post('/api/sessions', (req, res) => {
    const body = z.object({ browserEnabled: z.boolean(), screenEnabled: z.boolean() }).strict().refine(value => value.browserEnabled || value.screenEnabled, 'Enable browser or screen tracking.').parse(req.body);
    res.status(201).json(store.startSession(body));
  });
  app.delete('/api/sessions/current', (_req, res) => { store.stopSession(); res.sendStatus(204); });
  app.get('/api/settings', (_req, res) => res.json({ gmailConfigured: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET, inboxes: store.listInboxes().map(safeInbox), extensionToken: store.getMeta('extensionToken'), session: store.getSession() }));
  app.get('/api/pairing', (_req, res) => res.json({ token: store.getMeta('extensionToken') }));
  app.post('/api/events', (req, res) => {
    const input = captureEventSchema.parse(req.body) as CaptureEvent;
    if (input.source === 'browser' || input.source === 'visual') {
      const session = store.getSession();
      if (!session || (input.source === 'browser' && !session.browserEnabled) || (input.source === 'visual' && !session.screenEnabled)) throw new HttpError(409, 'Start the appropriate tracking mode before sending capture evidence.');
    }
    res.status(201).json(ingestEvent(store, input));
  });
  app.post('/api/evidence/:id/review', (req, res) => { const { action } = z.object({ action: z.enum(['accept', 'dismiss']) }).strict().parse(req.body); res.json(reviewEvidence(store, req.params.id, action)); });
  app.get('/api/export', (req, res) => {
    const records = store.listApplications(getWorkspace(req.query.workspace));
    const headers = ['Company', 'Role', 'Stage', 'Applied', 'Location', 'Work arrangement', 'Salary', 'Job URL', 'Job ID', 'Email', 'CV', 'Cover letter', 'Recruiter', 'Recruiter email', 'Priority', 'Next action', 'Deadline', 'Notes'];
    const rows = records.map(record => {
      const nextTask = record.tasks.filter(task => !task.completedAt).sort((a,b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'))[0];
      return [record.company, record.role, record.stage, record.appliedAt ?? '', record.location, record.workMode, record.salary, record.url, record.jobId, record.email, record.resumeName, record.coverLetterName, record.recruiterName, record.recruiterEmail, record.priority, nextTask?.title ?? '', nextTask?.dueAt ?? '', record.notes];
    });
    res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="applications.csv"');
    res.send('\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n'));
  });
  app.use(apiErrorHandler);
  return { app, store, close: () => store.close() };
}

function safeInbox(inbox: Inbox): Inbox {
  return { id: inbox.id, provider: 'gmail', email: inbox.email, status: inbox.status, lastSyncAt: inbox.lastSyncAt, error: inbox.error };
}
export function csvCell(value: string): string {
  // Spreadsheet applications execute formulas even inside quoted CSV cells.
  const safe = /^[\s]*[=+@\-\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
